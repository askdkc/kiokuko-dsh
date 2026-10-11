interface DshClientContext {
  get?(name:string,required?:false):unknown;
  slots: {
    inject(name:string,register:()=>unknown):unknown;
    register(definition:{name:string;id?:string;order?:number;label?:string;locale:string;inject?:()=>Record<string,unknown>},component:(props:Record<string,unknown>)=>unknown):unknown;
  };
  locale:{register(namespace:string,dictionaries:Record<string,Record<string,string>>):unknown};
  effect(setup:()=>void|(()=>void|Promise<void>),label:string):unknown;
  on(event:'command/executed',listener:(sessionId:string,name:string,result:{readonly kind:string})=>void):unknown;
}
interface SnapshotStore<T> {
  getSnapshot(): T;
  update(update: (state: T) => void): void;
}
declare const createSnapshotStore: <T>(initial: T) => SnapshotStore<T>;
declare const jsx: (
  component: unknown,
  props: Record<string, unknown>,
  key?: string | number,
) => unknown;
declare const jsxs: (
  component: unknown,
  props: Record<string, unknown>,
  key?: string | number,
) => unknown;
declare const Fragment: unknown;
declare const useState: <T>(initial: T | (() => T)) => [T, (value: T) => void];
declare const useRef: <T>(initial: T) => { current: T };
declare const useEffect: (
  effect: () => void | (() => void),
  dependencies: readonly unknown[],
) => void;
declare const Modal: unknown;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export const inject = ["slots", "locale"] as const;
export function apply(ctx: DshClientContext): void {
  mountModelsClient(ctx);
}

const MODELS_NS = "kiokuko-models";
const MODEL_CONNECTION_DEFAULTS: Record<string, readonly string[]> = {
  openai: ["OpenAI API", "https://api.openai.com/v1", "responses"],
  codex: ["Codex", "https://chatgpt.com/backend-api/codex", "responses"],
  claude: ["Claude", "https://api.anthropic.com", "messages"],
  xai: ["xAI", "https://api.x.ai/v1", "chat-completions"],
  deepseek: ["DeepSeek", "https://api.deepseek.com/v1", "chat-completions"],
  opencode: ["OpenCode Zen", "https://opencode.ai/zen/v1", "chat-completions"],
  "opencode-go": [
    "OpenCode Go",
    "https://opencode.ai/zen/go/v1",
    "chat-completions",
  ],
  openrouter: [
    "OpenRouter",
    "https://openrouter.ai/api/v1",
    "chat-completions",
  ],
  nous: [
    "Nous / Hermes",
    "https://inference-api.nousresearch.com/v1",
    "chat-completions",
  ],
  infron: ["Infron", "https://llm.onerouter.pro/v1", "chat-completions"],
  ollama: ["Ollama", "http://localhost:11434/v1", "chat-completions"],
  custom: ["Custom connection", "http://localhost:8080/v1", "chat-completions"],
};
/** Providers whose stored credential can also be an OAuth sign-in. */
const OAUTH_KINDS = ["codex", "claude", "xai", "openai", "openrouter", "nous"];
async function modelsApi(
  body?: Record<string, unknown>,
  query = "",
): Promise<any> {
  const response = await fetch("/api/kiokuko.models" + query, {
    ...(body
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    cache: "no-store",
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error ?? "Kiokuko Models request failed");
  return value;
}
/** The Settings page and command dialog render this exact management component. */
function KiokukoModelsPanel(props: Record<string, unknown>): unknown {
  const [state, setState] = useState<any>({ revision: 0, connections: [] }),
    [connection, setConnection] = useState<any>(null),
    [models, setModels] = useState<any[]>([]),
    [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [key, setKey] = useState(""),
    [auth, setAuth] = useState<any>(null),
    [answer, setAnswer] = useState("");
  const [manual, setManual] = useState({
    id: "",
    contextWindow: 262144,
    maxTokens: 32768,
    reasoning: false,
    image: false,
  });
  // Both disclosures are state-held: a rerender that shifts the leading
  // status paragraphs remounts the editor, and a DOM-held `open` would snap
  // shut under the user mid-task.
  const [advanced, setAdvanced] = useState(false),
    [manualOpen, setManualOpen] = useState(false);
  const operation = useRef<string | undefined>(undefined),
    mounted = useRef(true),
    working = useRef(false);
  const sessionId = props.sessionId as string | undefined;
  const load = async () => {
    const value = await modelsApi();
    if (mounted.current) setState(value);
    return value;
  };
  useEffect(() => {
    mounted.current = true;
    void load().catch((e) => setError(messageOf(e)));
    return () => {
      mounted.current = false;
      if (operation.current)
        void modelsApi({ op: "cancel", id: operation.current }).catch(
          () => undefined,
        );
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) setError(messageOf(e));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const choose = async (c: any): Promise<any[]> => {
    setConnection({ ...c });
    setKey("");
    setError("");
    setModels([]);
    try {
      const list = (await modelsApi(
        undefined,
        "?op=models&id=" + encodeURIComponent(c.id),
      )) as any[];
      setModels(list);
      return list;
    } catch (e) {
      setError(messageOf(e));
      return [];
    }
  };
  /** Store the editor's current fields. Every action below needs this first. */
  const persist = async () => {
    await modelsApi({
      op: "save",
      connection: {
        id: connection.id,
        kind: connection.kind,
        name: connection.name,
        baseURL: connection.baseURL,
        protocol: connection.protocol,
        serviceTier: connection.serviceTier,
        models: connection.models,
      },
      revision: (await load()).revision,
    });
  };
  const reopen = async (): Promise<any[]> => {
    const saved = await load();
    return choose(
      saved.connections.find((c: any) => c.id === connection.id) ?? connection,
    );
  };
  /**
   * The whole add-a-provider flow in one action: store the connection, store the
   * typed key, then ask the adapter which models it serves. A discovery that
   * fails still leaves the connection and key stored, so the panel reports the
   * cause and keeps the manual registration path instead of discarding work.
   */
  const connect = async () => {
    const draft = { ...connection };
    await persist();
    const typed = key.trim();
    if (typed) {
      await modelsApi({ op: "key", id: draft.id, key: typed });
      setKey("");
    }
    let failure = "";
    try {
      await modelsApi({ op: "refresh", id: draft.id });
    } catch (e) {
      failure = messageOf(e);
    }
    const list = await reopen();
    if (failure) {
      setNotice(typed ? "Connection and key saved" : "Connection saved");
      setError(
        failure + " Register a model manually if this endpoint stays unusable.",
      );
    } else
      setNotice(
        list.length
          ? "Connected · " + list.length + " model(s)"
          : "Connected; no models discovered yet",
      );
  };
  const newConnection = (kind: string) => {
    const spec = MODEL_CONNECTION_DEFAULTS[kind]!;
    setConnection({
      id: "kiokuko-" + kind + "-" + crypto.randomUUID().slice(0, 8),
      kind,
      name: spec[0],
      baseURL: spec[1],
      protocol: spec[2],
      serviceTier: "standard",
      models: [],
    });
    setModels([]);
    setKey("");
    setError("");
    setNotice("");
  };
  const update = (field: string, value: unknown) =>
    setConnection({ ...connection, [field]: value });
  const startLogin = async () => {
    await persist();
    const result = await modelsApi({ op: "login", id: connection.id });
    operation.current = result.operationId;
    setAuth({ id: result.operationId, status: "pending", events: [] });
  };
  useEffect(() => {
    if (!auth || auth.status !== "pending") return;
    let stopped = false;
    const timer = setInterval(() => {
      void modelsApi(
        undefined,
        "?op=auth&id=" + encodeURIComponent(auth.id),
      ).then(
        (next) => {
          if (stopped) return;
          setAuth(next);
          if (next.status !== "pending") {
            operation.current = undefined;
            void reopen()
              .then(() => {
                if (next.status !== "success")
                  setError(next.error ?? "Authentication cancelled");
              })
              .catch((e) => setError(messageOf(e)));
          }
        },
        (e) => {
          if (!stopped) setError(messageOf(e));
        },
      );
    }, 500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [auth?.id, auth?.status]);
  const input = (
    label: string,
    value: unknown,
    onChange: (value: string) => void,
    type = "text",
    submit?: () => void,
  ) =>
    jsx("label", {
      children: jsxs(Fragment, {
        children: [
          jsx("span", { children: label }),
          jsx("input", {
            type,
            value,
            "aria-label": label,
            disabled:
              busy ||
              (label === "Base URL" &&
                ["codex", "opencode", "opencode-go"].includes(
                  connection?.kind,
                )),
            onChange: (e: any) => onChange(e.target.value),
            ...(submit
              ? {
                  onKeyDown: (e: any) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    submit();
                  },
                }
              : {}),
            autoComplete: type === "password" ? "new-password" : "off",
          }),
        ],
      }),
    });
  const button = (label: string, action: () => void, disabled = false) =>
    jsx("button", {
      type: "button",
      disabled: busy || disabled,
      onClick: action,
      children: label,
    });
  return jsxs("section", {
    className: "kiokuko-models-panel",
    "aria-label": "Kiokuko Models",
    "aria-busy": busy,
    children: [
      jsx("h2", { children: "Kiokuko Models" }),
      jsx("p", {
        children:
          "Connect directly for chat, Enno and Deep. Credentials are shared with dsh-cli. Signing out also signs dsh-cli out.",
      }),
      ...(error
        ? [jsx("p", { role: "alert", children: error }, "error")]
        : []),
      ...(notice
        ? [jsx("p", { role: "status", children: notice }, "notice")]
        : []),
      ...(busy
        ? [jsx("p", { role: "status", children: "Working…" }, "busy")]
        : []),
      button("Reload", () => void run(load)),
      jsx("label", {
        children: jsxs(Fragment, {
          children: [
            "Add connection",
            jsxs("select", {
              "aria-label": "Add connection",
              value: "",
              disabled: busy,
              onChange: (e: any) => newConnection(e.target.value),
              children: [
                jsx("option", { value: "", children: "Choose provider…" }),
                ...Object.entries(MODEL_CONNECTION_DEFAULTS).map(([id, spec]) =>
                  jsx("option", { value: id, children: spec[0] }, id),
                ),
              ],
            }),
          ],
        }),
      }),
      jsx("ul", {
        children: state.connections.map((c: any) =>
          jsx(
            "li",
            {
              children: button(
                c.name + " · " + c.authState,
                () => void choose(c),
              ),
            },
            c.id,
          ),
        ),
      }),
      ...(connection
        ? [
            jsxs("div", {
              className: "kiokuko-models-editor",
              key: "editor",
              children: [
                jsxs("h3", {
                  children: [
                    connection.name,
                    jsx("span", {
                      className: "kiokuko-models-state",
                      children:
                        " · " + (connection.authState ?? "not saved yet"),
                    }),
                  ],
                }),
                ...(connection.kind !== "codex" && connection.kind !== "ollama"
                  ? [
                      input(
                        "API key / bearer token",
                        key,
                        setKey,
                        "password",
                        () => {
                          if (!busy && key.trim()) void run(connect);
                        },
                      ),
                    ]
                  : []),
                jsxs("div", {
                  className: "kiokuko-models-actions",
                  children: [
                    button("Save and connect", () => void run(connect)),
                    ...(OAUTH_KINDS.includes(connection.kind)
                      ? [
                          button(
                            "Log in",
                            () => void run(startLogin),
                            auth?.status === "pending",
                          ),
                        ]
                      : []),
                  ],
                }),
                jsx("p", {
                  children:
                    connection.kind === "ollama"
                      ? "Ollama needs no key. Save and connect to list its models."
                      : "Paste the API key and press Enter, or use Save and connect. The key is stored with dsh-cli's shared credentials.",
                }),
                ...(auth?.status === "pending"
                  ? [
                      jsxs("div", {
                        "aria-label": "Authentication",
                        children: [
                          jsx("p", {
                            role: "status",
                            children: "Waiting for authentication",
                          }),
                          ...auth.events.map((event: any, index: number) =>
                            jsx(
                              "div",
                              {
                                children:
                                  event.type === "auth_url"
                                    ? jsxs(Fragment, {
                                        children: [
                                          jsx("a", {
                                            href: event.url,
                                            target: "_blank",
                                            rel: "noopener noreferrer",
                                            children:
                                              "Open authentication link",
                                          }),
                                          jsx("p", {
                                            children: event.instructions,
                                          }),
                                        ],
                                      })
                                    : event.type === "device_code"
                                      ? jsxs(Fragment, {
                                          children: [
                                            jsx("a", {
                                              href: event.verificationUri,
                                              target: "_blank",
                                              rel: "noopener noreferrer",
                                              children: "Open sign-in page",
                                            }),
                                            jsx("p", {
                                              children:
                                                "Code: " + event.userCode,
                                            }),
                                          ],
                                        })
                                      : jsxs(Fragment, {
                                          children: [
                                            jsx("p", {
                                              children: event.message,
                                            }),
                                            ...(event.links ?? []).map(
                                              (link: any) =>
                                                jsx(
                                                  "a",
                                                  {
                                                    href: link.url,
                                                    target: "_blank",
                                                    rel: "noopener noreferrer",
                                                    children:
                                                      link.label ?? "Open link",
                                                  },
                                                  link.url,
                                                ),
                                            ),
                                          ],
                                        }),
                              },
                              index,
                            ),
                          ),
                          ...(auth.prompt
                            ? [
                                auth.prompt.type === "select"
                                  ? jsx("label", {
                                      children: jsxs(Fragment, {
                                        children: [
                                          auth.prompt.message,
                                          jsxs("select", {
                                            "aria-label": auth.prompt.message,
                                            value: answer,
                                            onChange: (e: any) =>
                                              setAnswer(e.target.value),
                                            children: [
                                              jsx("option", {
                                                value: "",
                                                children: "Choose…",
                                              }),
                                              ...auth.prompt.options.map(
                                                (option: any) =>
                                                  jsx(
                                                    "option",
                                                    {
                                                      value: option.id,
                                                      children: option.label,
                                                    },
                                                    option.id,
                                                  ),
                                              ),
                                            ],
                                          }),
                                        ],
                                      }),
                                    })
                                  : input(
                                      auth.prompt.message,
                                      answer,
                                      setAnswer,
                                      auth.prompt.type === "secret"
                                        ? "password"
                                        : "text",
                                    ),
                                button(
                                  "Submit authentication answer",
                                  () =>
                                    void run(async () => {
                                      await modelsApi({
                                        op: "answer",
                                        id: auth.id,
                                        answer,
                                      });
                                      setAnswer("");
                                    }),
                                ),
                              ]
                            : []),
                          button(
                            "Cancel authentication",
                            () =>
                              void run(async () => {
                                await modelsApi({ op: "cancel", id: auth.id });
                                operation.current = undefined;
                                setAuth(null);
                                setNotice("Authentication cancelled");
                              }),
                          ),
                        ],
                      }),
                    ]
                  : []),
                jsxs("details", {
                  open: advanced,
                  children: [
                    jsx("summary", {
                      onClick: (e: any) => {
                        e.preventDefault();
                        setAdvanced(!advanced);
                      },
                      children: "Advanced settings",
                    }),
                    input("Connection name", connection.name, (value) =>
                      update("name", value),
                    ),
                    input("Base URL", connection.baseURL, (value) =>
                      update("baseURL", value),
                    ),
                    jsx("label", {
                      children: jsxs(Fragment, {
                        children: [
                          "Protocol",
                          jsx("select", {
                            "aria-label": "Protocol",
                            value: connection.protocol,
                            disabled:
                              busy ||
                              [
                                "codex",
                                "infron",
                                "opencode",
                                "opencode-go",
                              ].includes(connection.kind),
                            onChange: (e: any) =>
                              update("protocol", e.target.value),
                            children: [
                              ["chat-completions", "Chat Completions"],
                              ["responses", "Responses"],
                              ["messages", "Messages"],
                            ].map(([id, name]) =>
                              jsx("option", { value: id, children: name }, id),
                            ),
                          }),
                        ],
                      }),
                    }),
                    ...(connection.kind === "infron"
                      ? [
                          jsx("label", {
                            children: jsxs(Fragment, {
                              children: [
                                "Service tier",
                                jsx("select", {
                                  "aria-label": "Service tier",
                                  value: connection.serviceTier,
                                  disabled: busy,
                                  onChange: (e: any) =>
                                    update("serviceTier", e.target.value),
                                  children: [
                                    jsx("option", {
                                      value: "standard",
                                      children: "Standard",
                                    }),
                                    jsx("option", {
                                      value: "flex",
                                      children: "Flex",
                                    }),
                                  ],
                                }),
                              ],
                            }),
                          }),
                          jsx("p", {
                            children:
                              "Requested tier: " +
                              connection.serviceTier +
                              ". Last request: " +
                              (connection.lastRequestedTier ?? "none") +
                              ". Actual served tier: " +
                              (connection.actualTier ?? "unknown") +
                              ". Infron may serve Standard for a Flex request.",
                          }),
                        ]
                      : []),
                    button(
                      "Save connection",
                      () =>
                        void run(async () => {
                          await persist();
                          await reopen();
                          setNotice("Connection saved");
                        }),
                    ),
                    button(
                      "Refresh models",
                      () =>
                        void run(async () => {
                          await persist();
                          await modelsApi({ op: "refresh", id: connection.id });
                          const list = await reopen();
                          setNotice(
                            list.length
                              ? "Models refreshed"
                              : "Models refreshed; none discovered",
                          );
                        }),
                    ),
                    button(
                      "Log out (also dsh-cli)",
                      () =>
                        void run(async () => {
                          await persist();
                          await modelsApi({ op: "logout", id: connection.id });
                          setKey("");
                          setModels([]);
                          await load();
                          setNotice("Signed out");
                        }),
                    ),
                    ...(!["opencode", "opencode-go"].includes(connection.kind)
                      ? [
                          jsx("details", {
                            open: manualOpen,
                            children: jsxs(Fragment, {
                              children: [
                                jsx("summary", {
                                  onClick: (e: any) => {
                                    e.preventDefault();
                                    setManualOpen(!manualOpen);
                                  },
                                  children: "Register model manually",
                                }),
                                input("Model ID", manual.id, (value) =>
                                  setManual({ ...manual, id: value }),
                                ),
                                input(
                                  "Context window",
                                  manual.contextWindow,
                                  (value) =>
                                    setManual({
                                      ...manual,
                                      contextWindow: Number(value),
                                    }),
                                  "number",
                                ),
                                input(
                                  "Maximum output tokens",
                                  manual.maxTokens,
                                  (value) =>
                                    setManual({
                                      ...manual,
                                      maxTokens: Number(value),
                                    }),
                                  "number",
                                ),
                                jsx("label", {
                                  children: jsxs(Fragment, {
                                    children: [
                                      jsx("input", {
                                        type: "checkbox",
                                        checked: manual.reasoning,
                                        onChange: (e: any) =>
                                          setManual({
                                            ...manual,
                                            reasoning: e.target.checked,
                                          }),
                                      }),
                                      "Reasoning supported",
                                    ],
                                  }),
                                }),
                                jsx("label", {
                                  children: jsxs(Fragment, {
                                    children: [
                                      jsx("input", {
                                        type: "checkbox",
                                        checked: manual.image,
                                        onChange: (e: any) =>
                                          setManual({
                                            ...manual,
                                            image: e.target.checked,
                                          }),
                                      }),
                                      "Image input supported",
                                    ],
                                  }),
                                }),
                                button(
                                  "Add manual model",
                                  () => {
                                    update("models", [
                                      ...connection.models.filter(
                                        (m: any) => m.id !== manual.id,
                                      ),
                                      { ...manual, name: manual.id },
                                    ]);
                                    setNotice(
                                      "Model added to draft. Save connection to register it.",
                                    );
                                  },
                                  !manual.id,
                                ),
                              ],
                            }),
                          }),
                        ]
                      : []),
                  ],
                }),
                jsx("h4", { children: "Models" }),
                ...(models.length === 0
                  ? [
                      jsx("p", {
                        children:
                          "No models yet. Save and connect to discover them, or register one under Advanced settings.",
                      }),
                    ]
                  : []),
                input("Search models", filter, setFilter),
                jsx("ul", {
                  children: models
                    .filter((m) =>
                      (m.id + " " + m.name)
                        .toLowerCase()
                        .includes(filter.toLowerCase()),
                    )
                    .map((m) =>
                      jsx(
                        "li",
                        {
                          children: jsxs(Fragment, {
                            children: [
                              jsx("span", { children: m.name + " · " + m.id }),
                              button(
                                "Use in current chat",
                                () =>
                                  void run(async () => {
                                    await modelsApi({
                                      op: "select",
                                      id: connection.id,
                                      model: m.id,
                                      scope: "current",
                                      sessionId,
                                    });
                                    setNotice("Model selected for this chat");
                                  }),
                                !sessionId,
                              ),
                              button(
                                "Default for new chats",
                                () =>
                                  void run(async () => {
                                    await modelsApi({
                                      op: "select",
                                      id: connection.id,
                                      model: m.id,
                                      scope: "default",
                                    });
                                    setNotice(
                                      "Default model saved for new chats",
                                    );
                                  }),
                              ),
                            ],
                          }),
                        },
                        m.id,
                      ),
                    ),
                }),
              ],
            }),
          ]
        : []),
    ],
  });
}
function KiokukoModelsDialog(props: Record<string, unknown>): unknown {
  const useModels = props.useKiokukoModels as (
    selector: (s: { open: boolean; sessionId?: string }) => any,
  ) => any;
  const state = useModels((s) => s),
    close = props.closeModels as () => void;
  return jsx(Modal, {
    open: state.open,
    className: "kiokuko-models-modal",
    title: "Kiokuko Models",
    closeLabel: "Close",
    onClose: close,
    children: state.open
      ? jsx(KiokukoModelsPanel, { sessionId: state.sessionId })
      : null,
  });
}
function KiokukoModelsAnchor(props: Record<string, unknown>): unknown {
  const active = props.activeModelsSession as { current: string | undefined };
  useEffect(() => {
    active.current = props.sessionId as string;
    return () => {
      if (active.current === props.sessionId) active.current = undefined;
    };
  }, [props.sessionId]);
  return null;
}
export function mountModelsClient(ctx: DshClientContext): void {
  const store = createSnapshotStore<{ open: boolean; sessionId?: string }>({
      open: false,
    }),
    active = { current: undefined as string | undefined };
  let focusFrame: number | undefined;
  const close = () => {
    store.update((s) => {
      s.open = false;
    });
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined;
      const sessionId = active.current;
      if (!sessionId) return;
      const sessions = ctx.get?.("sessions", false) as {scope(id:string):{get(name:string,required:false):unknown}|undefined}|undefined;
      const scope = sessions?.scope(sessionId);
      if (!scope) return;
      const conversation = scope.get("conversation", false) as {input:{for(scope:unknown):{focus():void}}}|undefined;
      conversation?.input.for(scope).focus();
    });
  };
  ctx.effect(() => () => {
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame);
  }, "kiokuko models focus lifecycle");
  ctx.effect(() => {
    const style = document.createElement("style");
    style.textContent =
      ".kiokuko-models-modal{width:min(900px,calc(100vw - 32px))}.kiokuko-models-panel{box-sizing:border-box;width:100%;max-width:900px;padding:16px;overflow:auto;max-height:75vh}.kiokuko-models-panel label{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.kiokuko-models-panel input,.kiokuko-models-panel select{max-width:100%;box-sizing:border-box;border:1px solid #888;border-radius:6px;padding:8px;color:inherit;background:transparent}.kiokuko-models-panel button{border:1px solid #888;border-radius:6px;padding:8px;margin:4px;color:inherit}.kiokuko-models-panel button:disabled{opacity:.5}.kiokuko-models-panel li{margin:8px 0}.kiokuko-models-panel :focus-visible{outline:2px solid #3286ff;outline-offset:3px}.kiokuko-models-panel summary{cursor:pointer;margin:12px 0}.kiokuko-models-panel h3,.kiokuko-models-panel h4{margin:12px 0 0}.kiokuko-models-state{font-weight:400;font-size:.85em;opacity:.75}.kiokuko-models-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}";
    document.head.append(style);
    return () => style.remove();
  }, "kiokuko models style");
  ctx.slots.inject("settings.section", () =>
    ctx.slots.register(
      {
        name: "settings.section",
        id: MODELS_NS,
        order: 1000,
        label: "Kiokuko Models",
        locale: MODELS_NS,
      },
      () => jsx(KiokukoModelsPanel, { sessionId: active.current }),
    ),
  );
  ctx.slots.inject("conversation.input.left", () =>
    ctx.slots.register(
      {
        name: "conversation.input.left",
        id: "kiokuko-models-dialog",
        locale: MODELS_NS,
        inject: () => ({
          hooks: { kiokukoModels: store },
          closeModels: close,
          activeModelsSession: active,
        }),
      },
      KiokukoModelsAnchor,
    ),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register(
      {
        name: "shell.overlay",
        id: "kiokuko-models-overlay",
        locale: MODELS_NS,
        inject: () => ({ hooks: { kiokukoModels: store }, closeModels: close }),
      },
      KiokukoModelsDialog,
    ),
  );
  ctx.on("command/executed", (sessionId, name, result) => {
    if (name === "kiokuko" && result.kind === "success")
      store.update((s) => {
        s.open = true;
        s.sessionId = sessionId;
      });
  });
  ctx.effect(
    () =>
      ctx.locale.register(MODELS_NS, {
        en: { "meta.title": "Kiokuko Models" },
        ja: { "meta.title": "Kiokuko Models" },
      }) as () => void,
    "kiokuko models labels",
  );
}
