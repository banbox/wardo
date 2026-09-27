"""Dependency-free Python runtime for Wardo.

It mirrors the TypeScript workflow API, persists the same .wardo layout, and
supports OpenAI chat/responses plus Anthropic messages HTTP formats.
"""
from __future__ import annotations

import argparse, concurrent.futures, json, os, re, signal, subprocess, sys, threading, time, urllib.error, urllib.request, uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Protocol


@dataclass
class RetryPolicy:
    delays_ms: list[int] = field(default_factory=lambda: [60000, 180000, 480000, 1200000])
    max_attempts: int = 5

@dataclass
class ProviderConfig:
    type: str = "openai"
    name: str | None = None
    api_key: str | None = None
    base_url: str | None = None
    models: list[str] = field(default_factory=list)
    headers: dict[str, str] = field(default_factory=dict)
    request_format: str | None = None

@dataclass
class WardoConfig:
    max_concurrency: int = 3
    retry: RetryPolicy = field(default_factory=RetryPolicy)
    providers: dict[str, ProviderConfig] = field(default_factory=lambda: {"openai": ProviderConfig(), "anthropic": ProviderConfig("anthropic")})
    provider_order: list[str] = field(default_factory=lambda: ["openai", "anthropic"])
    model_preferences: list[str] = field(default_factory=list)
    provider_concurrency: dict[str, int] = field(default_factory=dict)
    judge: dict[str, Any] = field(default_factory=dict)

@dataclass
class TaskSpec:
    id: str
    goal: str
    acceptance: str
    parent_id: str | None = None
    depends_on: list[str] = field(default_factory=list)
    provider: str = "auto"
    model: str | None = None
    max_attempts: int | None = None
    children: list["TaskSpec"] = field(default_factory=list)
    context_policy: str = "summary"

@dataclass
class WorkflowSpec:
    id: str
    objective: str
    tasks: list[TaskSpec]
    max_concurrency: int | None = None
    fail_fast: bool = False

@dataclass
class TaskResult:
    status: str
    text: str = ""
    attempt: int = 0
    provider: str | None = None
    session_id: str | None = None
    checkpoint: dict[str, Any] | None = None
    usage: Any = None
    error: str | None = None
    structured: Any = None

def define_task(task: Mapping[str, Any] | None = None, **kwargs: Any) -> TaskSpec:
    # Accept the TypeScript spellings too, so generated scripts can switch
    # runtimes without changing their workflow declarations.
    if task is not None: kwargs = {**dict(task), **kwargs}
    aliases = {"parentId": "parent_id", "dependsOn": "depends_on", "maxAttempts": "max_attempts", "contextPolicy": "context_policy"}
    for source, target in aliases.items():
        if source in kwargs and target not in kwargs: kwargs[target] = kwargs.pop(source)
    return TaskSpec(**kwargs)

def define_workflow(workflow: Mapping[str, Any] | None = None, **kwargs: Any) -> WorkflowSpec:
    if workflow is not None: kwargs = {**dict(workflow), **kwargs}
    aliases = {"maxConcurrency": "max_concurrency", "failFast": "fail_fast"}
    for source, target in aliases.items():
        if source in kwargs and target not in kwargs: kwargs[target] = kwargs.pop(source)
    return WorkflowSpec(**kwargs)


def _expand(value: Any, env: Mapping[str, str]) -> Any:
    if isinstance(value, str): return re.sub(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}", lambda m: env.get(m.group(1), ""), value)
    if isinstance(value, list): return [_expand(x, env) for x in value]
    if isinstance(value, dict): return {k: _expand(v, env) for k, v in value.items()}
    return value

def _scalar(s: str) -> Any:
    s = s.strip()
    if not s: return None
    if s.lower() in ("true", "false"): return s.lower() == "true"
    if s in ("null", "~"): return None
    if s.startswith("[") and s.endswith("]"):
        try: return json.loads(s.replace("'", '"'))
        except Exception: pass
    if (s[:1] == s[-1:] and s[:1] in "\"'"): return s[1:-1]
    try: return float(s) if "." in s else int(s)
    except ValueError: return s

def _yaml(text: str) -> dict[str, Any]:
    try:
        import yaml  # type: ignore
        return yaml.safe_load(text) or {}
    except Exception: pass
    # Minimal map/list parser for config.yml when PyYAML is unavailable.
    lines = [(len(x)-len(x.lstrip()), x.strip()) for x in text.splitlines() if x.strip() and not x.lstrip().startswith("#")]
    def block(index: int, indent: int):
        is_list = index < len(lines) and lines[index][0] == indent and lines[index][1].startswith("- ")
        value: Any = [] if is_list else {}
        while index < len(lines) and lines[index][0] == indent:
            line = lines[index][1]
            if is_list:
                if not line.startswith("- "): break
                item = line[2:].strip(); index += 1
                if ":" in item:
                    key, raw = item.split(":", 1); obj = {key.strip(): _scalar(raw)}
                    if not raw.strip() and index < len(lines) and lines[index][0] > indent:
                        child, index = block(index, lines[index][0]); obj[key.strip()] = child
                    if index < len(lines) and lines[index][0] > indent:
                        extra, index = block(index, lines[index][0]);
                        if isinstance(extra, dict): obj.update(extra)
                    value.append(obj)
                else: value.append(_scalar(item))
            else:
                if ":" not in line: index += 1; continue
                key, raw = line.split(":", 1); key, raw = key.strip(), raw.strip(); index += 1
                if raw: value[key] = _scalar(raw)
                elif index < len(lines) and lines[index][0] > indent: value[key], index = block(index, lines[index][0])
                else: value[key] = {}
        return value, index
    return block(0, lines[0][0])[0] if lines else {}

def load_config(path: str | Path | None = None, env: Mapping[str, str] | None = None, workspace: str | Path | None = None) -> WardoConfig:
    env = dict(env or os.environ); path = Path(path or env.get("WARDO_CONFIG") or Path(env.get("WARDO_HOME", Path.home()/".wardo"))/"config.yml")
    raw = _expand(_yaml(path.read_text(encoding="utf-8")) if path.exists() else {}, env)
    providers: dict[str, ProviderConfig] = {}; order: list[str] = []; supplied = raw.get("providers", {})
    entries = supplied if isinstance(supplied, list) else [{"name": k, **(v if isinstance(v, dict) else {})} for k,v in supplied.items()]
    if not entries: entries = [{"name":"openai","type":"openai"},{"name":"anthropic","type":"anthropic"}]
    for i, item in enumerate(entries):
        item = item if isinstance(item, dict) else {}; typ = item.get("type", "openai"); typ = "openai-compatible" if typ == "local" else typ
        name = str(item.get("name") or ("local" if typ == "openai-compatible" else typ)); name = name if name not in providers else f"{name}-{i+1}"
        up = re.sub(r"[^A-Z0-9]", "_", name.upper()); std = "OPENAI" if typ == "openai" else "ANTHROPIC" if typ == "anthropic" else None
        key = item.get("apiKey") or env.get(f"WARDO_PROVIDER_{up}_API_KEY") or (env.get(std+"_API_KEY") if std else None) or (env.get("LOCAL_LLM_API_KEY") if typ == "openai-compatible" else None)
        base = item.get("baseUrl") or env.get(f"WARDO_PROVIDER_{up}_BASE_URL") or (env.get(std+"_BASE_URL") if std else None) or (env.get("LOCAL_LLM_BASE_URL") if typ == "openai-compatible" else None)
        models = item.get("models") or [x.strip() for x in env.get(f"WARDO_PROVIDER_{up}_MODELS", "").split(",") if x.strip()]
        providers[name] = ProviderConfig(typ, item.get("name"), key, base, list(models) if isinstance(models,list) else [], dict(item.get("headers") or {}), item.get("requestFormat")); order.append(name)
    prefs = env.get("WARDO_MODEL_PREFERENCES", raw.get("modelPreferences", [])); prefs = [x.strip() for x in prefs.split(",") if x.strip()] if isinstance(prefs,str) else list(prefs or [])
    retry = raw.get("retry") or {}
    return WardoConfig(max(1,int(env.get("WARDO_MAX_CONCURRENCY", raw.get("maxConcurrency",3)))), RetryPolicy([int(x) for x in retry.get("delaysMs",[60000,180000,480000,1200000])], int(retry.get("maxAttempts",5))), providers, order, prefs, dict(raw.get("providerConcurrency") or {}), dict(raw.get("judge") or {}))

class WardoStore:
    def __init__(self, workspace: str|Path): self.workspace=Path(workspace); self.root=self.workspace/".wardo"
    def init(self, prompt: str|None=None):
        for x in ("tasks","sessions","artifacts","summaries","scripts","locks"): (self.root/x).mkdir(parents=True,exist_ok=True)
        if prompt is not None: self.atomic_write("prompt.md",prompt,True)
    def atomic_write(self, rel: str, value: Any, raw=False):
        target=self.root/rel; target.parent.mkdir(parents=True,exist_ok=True); tmp=target.with_name(target.name+f".tmp-{os.getpid()}-{time.time_ns()}"); tmp.write_text(value if raw else json.dumps(value,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); tmp.replace(target)
    def read_json(self, rel: str):
        try: return json.loads((self.root/rel).read_text(encoding="utf-8"))
        except FileNotFoundError: return None
    def save_task_state(self, task_id: str, state: Any): self.atomic_write(f"tasks/{task_id}/state.json",state)
    def save_attempt(self, task_id: str, attempt: str, result: Any, output=""):
        self.atomic_write(f"tasks/{task_id}/{attempt}/result.json",result); self.atomic_write(f"tasks/{task_id}/{attempt}/output.md",output,True)
    def append_event(self, event: dict[str, Any]):
        path = self.root / "tasks" / event["taskId"] / event["attemptId"] / "events.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")
    def save_session(self, session: dict[str,Any]): self.atomic_write(f"sessions/{session['provider']}-{session['sessionId']}.json",session)
    def read_session(self, provider: str, sid: str): return self.read_json(f"sessions/{provider}-{sid}.json")
    def lock(self):
        p=self.root/"locks/run.lock"; p.parent.mkdir(parents=True,exist_ok=True)
        try: fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY)
        except FileExistsError: raise RuntimeError("Another Wardo run holds .wardo/locks/run.lock")
        os.write(fd,str(os.getpid()).encode()); os.close(fd)
        return lambda: p.unlink(missing_ok=True)

@dataclass
class ClassifiedError: category: str; retryable: bool; message: str; status: int|None=None
def classify_error(error: BaseException) -> ClassifiedError:
    msg=str(error); low=msg.lower(); status=getattr(error,"status",None)
    if status in (401,403) or re.search(r"auth|api.?key|unauthori[sz]ed|forbidden",low): return ClassifiedError("auth",False,msg,status)
    if status==429 or re.search(r"rate.?limit|too many requests|overloaded",low): return ClassifiedError("rate_limit",True,msg,status)
    if isinstance(status,int) and status>=500 or re.search(r"503|server error|temporarily unavailable",low): return ClassifiedError("server",True,msg,status)
    if re.search(r"timeout|network|fetch failed|econn|enotfound|socket|connection",low): return ClassifiedError("network",True,msg,status)
    if status in (400,422) or re.search(r"invalid request|schema",low): return ClassifiedError("invalid",False,msg,status)
    return ClassifiedError("unknown",False,msg,status)

def _sleep(ms: int, stop_event: threading.Event | None = None) -> bool:
    if not stop_event:
        time.sleep(ms / 1000); return True
    return not stop_event.wait(ms / 1000)

def _json_text(text: str):
    try: return json.loads(text.strip())
    except Exception: pass
    m=re.search(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```",text,re.S)
    if m:
        try: return json.loads(m.group(1))
        except Exception: pass
    return None

class LlmRegistry:
    def __init__(self, config: WardoConfig, workspace=None, opener: Callable[...,Any]|None=None): self.config=config; self.opener=opener or urllib.request.urlopen
    def resolve(self, ref=None, role="general"):
        names=[]
        if isinstance(ref,str): names=[ref]
        if isinstance(ref,Mapping): names=[f"{ref.get('provider')}:{ref.get('model')}"]
        if not names: names=self.config.model_preferences
        for name in names+[f"{p}:{m}" for p in self.config.provider_order for m in (self.config.providers[p].models or (["claude-haiku-4-5"] if self.config.providers[p].type=="anthropic" else ["gpt-5-mini"]))]:
            bits=name.split(":",1); alias,model=(bits[0],bits[1]) if len(bits)==2 else (None,bits[0]); pn=alias if alias in self.config.providers else next((p for p in self.config.provider_order if p==alias or self.config.providers[p].type==alias),None)
            if not pn: pn=next((p for p in self.config.provider_order if model in self.config.providers[p].models),None)
            if pn: return pn,model,self.config.providers[pn]
        pn=self.config.provider_order[0]; p=self.config.providers[pn]; return pn,(p.models or ["gpt-5-mini"])[0],p
    def _candidates(self, ref=None, role="general"):
        first = self.resolve(ref, role)
        seen = {first[0]}
        result = [first]
        for pn in self.config.provider_order:
            if pn in seen or pn not in self.config.providers:
                continue
            p = self.config.providers[pn]
            model = (p.models or (["claude-haiku-4-5"] if p.type == "anthropic" else ["gpt-5-mini"]))[0]
            result.append((pn, model, p)); seen.add(pn)
        return result
    def _call(self,pn,p,model,prompt,schema=None):
        fmt=p.request_format or ("anthropic-messages" if p.type=="anthropic" else "openai-chat"); base=(p.base_url or ("https://api.anthropic.com/v1" if p.type=="anthropic" else "https://api.openai.com/v1")).rstrip("/")
        if fmt=="anthropic-messages": url=base+"/messages" if not base.endswith("/messages") else base; body={"model":model,"max_tokens":4096,"messages":[{"role":"user","content":prompt}]}; headers={"x-api-key":p.api_key or "","anthropic-version":"2023-06-01"}
        elif fmt=="openai-responses": url=base+"/responses" if not base.endswith("/responses") else base; body={"model":model,"input":prompt}; headers={"Authorization":f"Bearer {p.api_key or ''}"}
        else: url=base+"/chat/completions" if not base.endswith("/chat/completions") else base; body={"model":model,"messages":[{"role":"user","content":prompt}]}; headers={"Authorization":f"Bearer {p.api_key or ''}"}
        if schema is not None:
            extra="\nReturn only JSON matching this schema:\n"+json.dumps(schema,ensure_ascii=False)
            if "messages" in body: body["messages"][0]["content"]+=extra
            else: body["input"]+=extra
            if fmt!="anthropic-messages": body["response_format"]={"type":"json_object"}
        headers.update(p.headers); headers["Content-Type"]="application/json"; req=urllib.request.Request(url,json.dumps(body).encode(),headers=headers,method="POST")
        try:
            with self.opener(req,timeout=120) as response: data=json.loads(response.read().decode())
        except urllib.error.HTTPError as e:
            err=RuntimeError(e.read().decode(errors="replace")); err.status=e.code; raise err
        if fmt=="anthropic-messages": text="".join(x.get("text","") for x in data.get("content",[]) if isinstance(x,dict))
        elif fmt=="openai-responses": text=data.get("output_text","")
        else: text=data.get("choices",[{}])[0].get("message",{}).get("content","")
        return text,_json_text(text) if schema is not None else None,data.get("usage")
    def generate(self, role, prompt, schema=None, model=None, max_retries=None):
        total=max_retries or self.config.retry.max_attempts; last=None
        for pn,m,p in self._candidates(model, role):
            for n in range(total):
                try:
                    text,obj,usage=self._call(pn,p,m,prompt,schema)
                    if schema is not None and obj is None: raise ValueError("LLM returned invalid JSON")
                    return {"text":text,"object":obj,"usage":usage,"provider":pn,"model":m}
                except BaseException as e:
                    last=e; info=classify_error(e)
                    if not info.retryable or n+1>=total: break
                    time.sleep(self.config.retry.delays_ms[min(n,len(self.config.retry.delays_ms)-1)]/1000)
        raise last or RuntimeError("No LLM provider configured")

class AgentAdapter(Protocol):
    def start(self,prompt: str,cwd: str,model: str|None=None)->dict[str,Any]: ...
    def resume(self,session: dict[str,Any],prompt: str,model: str|None=None)->dict[str,Any]: ...
    def run(self,session: dict[str,Any],prompt: str,model: str|None=None)->Iterable[str]: ...

class SubprocessAdapter:
    def __init__(self,provider,command=None): self.provider=provider; self.command=command or provider
    def start(self,prompt,cwd,model=None): return {"provider":self.provider,"sessionId":str(uuid.uuid4()),"cwd":cwd}
    def resume(self,session,prompt,model=None): return session
    def run(self,session,prompt,model=None):
        args=[self.command,"exec",prompt] if self.provider=="codex" else [self.command,"-p",prompt]
        if model: args += ["--model",model]
        r=subprocess.run(args,cwd=session["cwd"],capture_output=True,text=True)
        if r.returncode: raise RuntimeError(r.stderr or f"{self.command} exited {r.returncode}")
        yield r.stdout

class TaskAgent:
    def __init__(self,adapters,registry,config,store,active_provider=None): self.adapters,self.registry,self.config,self.store,self.active_provider=adapters,registry,config,store,active_provider
    def execute(self,task,run_id,context="",stop_event=None):
        previous=self.store.read_json(f"tasks/{task.id}/state.json") or {}; base=previous.get("attempt",0) if previous.get("status") in ("paused","partial","retry_wait","running") else 0; follow=""; providers=self._providers(task); session=self.store.read_session(previous.get("provider"),previous.get("sessionId")) if previous.get("provider") and previous.get("sessionId") else None; last=TaskResult("unknown",attempt=base)
        for rel in range(1,(task.max_attempts or self.config.retry.max_attempts)+1):
            attempt=base+rel; provider,model=providers[min(rel-1,len(providers)-1)]; adapter=self.adapters.get(provider)
            if not adapter: return TaskResult("failed",error=f"No {provider} adapter configured",attempt=attempt)
            if stop_event and stop_event.is_set():
                return TaskResult("paused", text, attempt, provider, session.get("sessionId") if session else None)
            prompt=f"Task goal:\n{task.goal}\n\nAcceptance criteria:\n{task.acceptance}\n"+(f"\nDependency results:\n{context}\n" if context else "")+(f"\nPrevious judge feedback:\n{follow}\n" if follow else "")+"\nComplete the task and report changes and verification."
            text=""; started=None
            try:
                started=adapter.resume(session,prompt,model) if session and session.get("provider")==provider else adapter.start(prompt,str(self.store.workspace),model); self.store.save_session(started)
                self.store.append_event({"schemaVersion":1,"runId":run_id,"taskId":task.id,"attemptId":f"attempt-{attempt:04d}","seq":1,"ts":time.time(),"type":"session_started","provider":provider,"payload":{"sessionId":started.get("sessionId")}})
                for chunk in adapter.run(started,prompt,model):
                    text+=chunk; self.store.save_task_state(task.id,{"status":"running","text":text,"attempt":attempt,"provider":provider,"sessionId":started.get("sessionId")})
                    if stop_event and stop_event.is_set():
                        last = TaskResult("paused", text, attempt, provider, started.get("sessionId")); self.store.save_attempt(task.id, f"attempt-{attempt:04d}", asdict(last), text); return last
                session=started
            except BaseException as e:
                info=classify_error(e); last=TaskResult("retry_wait" if info.retryable else "failed",text,attempt,provider,started.get("sessionId") if started else None,error=info.message); self.store.append_event({"schemaVersion":1,"runId":run_id,"taskId":task.id,"attemptId":f"attempt-{attempt:04d}","seq":2,"ts":time.time(),"type":"error","provider":provider,"payload":{"error":info.message}}); self.store.save_attempt(task.id,f"attempt-{attempt:04d}",asdict(last),text)
                if not info.retryable or rel >= (task.max_attempts or self.config.retry.max_attempts): return last
                if not _sleep(self.config.retry.delays_ms[min(rel-1,len(self.config.retry.delays_ms)-1)], stop_event):
                    return TaskResult("paused", text, attempt, provider, started.get("sessionId") if started else None)
                session=None; continue
            try: decision=self.registry.generate("judge",f"Goal: {task.goal}\nAcceptance: {task.acceptance}\nOutput:\n{text or '(none)'}\nReturn JSON verdict pass|continue|fail, reason, retryable, missing, nextPrompt.",{"verdict":"pass|continue|fail","reason":"string","retryable":"boolean","missing":"array","nextPrompt":"string"})["object"]; self.store.atomic_write(f"tasks/{task.id}/attempt-{attempt:04d}/judge.json",decision); self.store.append_event({"schemaVersion":1,"runId":run_id,"taskId":task.id,"attemptId":f"attempt-{attempt:04d}","seq":3,"ts":time.time(),"type":"judge_decision","provider":"llm","payload":decision})
            except BaseException as e:
                info=classify_error(e); last=TaskResult("retry_wait" if info.retryable else "failed",text,attempt,provider,started.get("sessionId"),error=f"Judge failed: {info.message}"); self.store.save_attempt(task.id,f"attempt-{attempt:04d}",asdict(last),text)
                if not info.retryable or rel >= (task.max_attempts or self.config.retry.max_attempts): return last
                continue
            verdict=str(decision.get("verdict","fail")); last=TaskResult("succeeded" if verdict=="pass" else "partial" if verdict=="continue" else "failed",text,attempt,provider,started.get("sessionId")); self.store.save_attempt(task.id,f"attempt-{attempt:04d}",asdict(last),text)
            if verdict=="pass" or (verdict=="fail" and not decision.get("retryable",False)): return last
            follow=decision.get("nextPrompt") or decision.get("reason","Continue")
        return last
    def _providers(self,task):
        if task.provider in ("codex","claude"): return [(task.provider,task.model)]
        if task.model and ":" in task.model: p,m=task.model.split(":",1); return [("claude" if p in ("claude","anthropic") else "codex",m),("codex",None)]
        preferred=[("claude" if x.split(":",1)[0]=="anthropic" else "codex",x.split(":",1)[1] if ":" in x else None) for x in self.config.model_preferences if x.split(":",1)[0] in ("openai","anthropic")]; fallback=[(self.active_provider,None),("claude" if self.active_provider=="codex" else "codex",None)] if self.active_provider else [("codex",None),("claude",None)]; out=[]
        for p in preferred+fallback:
            if p[0] not in [x[0] for x in out]: out.append(p)
        return out

def _flatten(tasks,parent=None):
    out=[]
    for t in tasks:
        cur=TaskSpec(t.id,t.goal,t.acceptance,parent or t.parent_id,list(t.depends_on),t.provider,t.model,t.max_attempts,[],t.context_policy); out.append(cur); out += _flatten(t.children,t.id)
    return out
def _validate(tasks):
    ids={t.id for t in tasks}
    if len(ids)!=len(tasks): raise ValueError("Duplicate task id")
    for t in tasks:
        for d in t.depends_on:
            if d not in ids: raise ValueError(f"Unknown dependency {d} for {t.id}")
    visiting=set(); done=set(); by={t.id:t for t in tasks}
    def visit(i):
        if i in visiting: raise ValueError(f"Task dependency cycle includes {i}")
        if i in done:return
        visiting.add(i)
        for d in by[i].depends_on: visit(d)
        visiting.remove(i); done.add(i)
    for i in ids: visit(i)

class WorkflowRunner:
    def __init__(self,workflow,agent,store,config): self.workflow,self.agent,self.store,self.config,self.tasks=workflow,agent,store,config,_flatten(workflow.tasks); _validate(self.tasks)
    def run(self,resume=False,run_id=None,stop_event=None):
        release=self.store.lock(); results={}
        try:
            self.store.init(self.workflow.objective); saved=self.store.read_json("state.json") if resume else None
            if isinstance(saved,dict):
                for k,v in saved.items():
                    if v.get("status") not in ("paused","partial","retry_wait","running","ready","pending"): results[k]=TaskResult(**{x:v[x] for x in TaskResult.__dataclass_fields__ if x in v})
            rid=run_id or (self.store.read_json("workflow.json") or {}).get("runId") or str(uuid.uuid4()); self.store.atomic_write("workflow.json",{"runId":rid,"workflow":asdict(self.workflow)}); self.store.atomic_write("plan.json",{"schemaVersion":1,"objective":self.workflow.objective,"tasks":[asdict(t) for t in self.tasks]})
            active={}; limit=self.workflow.max_concurrency or self.config.max_concurrency
            with concurrent.futures.ThreadPoolExecutor(max_workers=limit) as pool:
                while len(results)<len(self.tasks) or active:
                    for t in self.tasks:
                        if t.id in results or t.id in active or len(active)>=limit: continue
                        if stop_event and stop_event.is_set(): break
                        deps=[results.get(d) for d in t.depends_on]
                        if any(d and d.status in ("failed","partial","blocked","cancelled","unknown") for d in deps): results[t.id]=TaskResult("blocked","A dependency failed"); continue
                        if not all(d and d.status=="succeeded" for d in deps): continue
                        results[t.id]=TaskResult("running"); context="\n\n".join(f"{d}: {results[d].text}" for d in t.depends_on); active[t.id]=pool.submit(self.agent.execute,t,rid,context,stop_event)
                    if not active:
                        if stop_event and stop_event.is_set(): break
                        unresolved=[t.id for t in self.tasks if t.id not in results]
                        if unresolved: raise RuntimeError("Scheduler stalled: "+", ".join(unresolved))
                        break
                    done,_=concurrent.futures.wait(active.values(),return_when=concurrent.futures.FIRST_COMPLETED)
                    for f in done:
                        tid=next(k for k,v in active.items() if v is f); active.pop(tid); results[tid]=f.result()
                        if results[tid].status == "paused":
                            self.store.atomic_write("state.json",{k:asdict(v) for k,v in results.items()})
                            return results
                        if self.workflow.fail_fast and results[tid].status=="failed":
                            for t in self.tasks:
                                if t.id not in results and t.id not in active: results[t.id]=TaskResult("cancelled","failFast")
                            active.clear(); break
                    self.store.atomic_write("state.json",{k:asdict(v) for k,v in results.items()})
            self.store.atomic_write("state.json",{k:asdict(v) for k,v in results.items()}); return results
        finally: release()

def plan_workflow(prompt,registry):
    result=registry.generate("planner","Decompose into a verifiable DAG. Return JSON only.\n"+prompt,{"objective":"string","tasks":[{"id":"string","dependsOn":["id"],"goal":"string","acceptance":"string","providerHint":"codex|claude"}]})["object"]
    return WorkflowSpec("planned",result.get("objective",prompt),[TaskSpec(t["id"],t["goal"],t["acceptance"],depends_on=t.get("dependsOn",[]),provider=t.get("providerHint","auto")) for t in result["tasks"]])
def run_workflow(workflow,workspace=".",config=None,adapters=None,resume=False,run_id=None,stop_event=None):
    cfg=config or load_config(workspace=workspace); store=WardoStore(workspace); registry=LlmRegistry(cfg,workspace); adapters=adapters or {"codex":SubprocessAdapter("codex"),"claude":SubprocessAdapter("claude")}; return WorkflowRunner(workflow,TaskAgent(adapters,registry,cfg,store,os.environ.get("WARDO_ACTIVE_AGENT")),store,cfg).run(resume,run_id,stop_event)
def fork_workflow(source_workspace, destination_workspace):
    source, destination = Path(source_workspace), Path(destination_workspace); destination.mkdir(parents=True, exist_ok=True)
    source_state, target_state = source/".wardo", destination/".wardo"
    if not source_state.exists(): raise FileNotFoundError(source_state)
    if target_state.exists(): import shutil; shutil.rmtree(target_state)
    import shutil; shutil.copytree(source_state, target_state)
    workflow = json.loads((target_state/"workflow.json").read_text(encoding="utf-8")); new_id = str(uuid.uuid4()); workflow["parentRunId"] = workflow.get("runId"); workflow["runId"] = new_id; (target_state/"workflow.json").write_text(json.dumps(workflow,ensure_ascii=False,indent=2)+"\n",encoding="utf-8"); return new_id
def execute(prompt,workspace=".",resume=False,plan="single",config=None,adapters=None,**kwargs):
    cfg=config or load_config(workspace=workspace); wf=plan_workflow(prompt,LlmRegistry(cfg,workspace)) if plan=="auto" else WorkflowSpec("single",prompt,[TaskSpec("main",prompt,"Complete the request and verify the result")]); return run_workflow(wf,workspace,cfg,adapters,resume,**kwargs)

def main():
    parser=argparse.ArgumentParser(prog="wardo"); sub=parser.add_subparsers(dest="command"); p=sub.add_parser("run"); p.add_argument("prompt",nargs="+"); p.add_argument("--plan",choices=("single","auto"),default="single"); p.add_argument("--workspace",default="."); p.add_argument("--resume",action="store_true"); r=sub.add_parser("resume"); r.add_argument("--workspace",default="."); s=sub.add_parser("status"); s.add_argument("--workspace",default="."); f=sub.add_parser("fork"); f.add_argument("destination"); f.add_argument("--workspace",default="."); sub.add_parser("env")
    a=parser.parse_args()
    if a.command=="run":
        stop = threading.Event(); signal.signal(signal.SIGINT, lambda *_: stop.set())
        print(json.dumps({k:asdict(v) for k,v in execute(" ".join(a.prompt),a.workspace,a.resume,a.plan,stop_event=stop).items()},ensure_ascii=False,indent=2))
    elif a.command=="resume":
        root=Path(a.workspace)/".wardo"; plan=json.loads((root/"plan.json").read_text(encoding="utf-8")); tasks=[TaskSpec(t["id"],t["goal"],t["acceptance"],parent_id=t.get("parent_id",t.get("parentId")),depends_on=t.get("depends_on",t.get("dependsOn",[])),provider=t.get("provider","auto"),model=t.get("model"),max_attempts=t.get("max_attempts",t.get("maxAttempts"))) for t in plan.get("tasks",[])]; cfg=load_config(workspace=a.workspace); result=run_workflow(WorkflowSpec("resumed",plan.get("objective","Resume Wardo workflow"),tasks),a.workspace,cfg,resume=True); print(json.dumps({k:asdict(v) for k,v in result.items()},ensure_ascii=False,indent=2))
    elif a.command=="status": print((Path(a.workspace)/".wardo/state.json").read_text(encoding="utf-8"))
    elif a.command=="fork": print(fork_workflow(a.workspace, a.destination))
    elif a.command=="env": print(json.dumps({"activeAgent":os.environ.get("WARDO_ACTIVE_AGENT"),"python":sys.version}))
    else: parser.print_help()
