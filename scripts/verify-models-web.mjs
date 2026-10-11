// Packed package, native Web profile with no configured keys, real local API and tool loop.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { chromium } from "playwright";
const exec = promisify(execFile),
  root = resolve(import.meta.dirname, ".."),
  base = await mkdtemp(join(tmpdir(), "kiokuko-models-web-"));
const env = {
  ...process.env,
  HOME: join(base, "home"),
  DSH_HOME: join(base, "dsh"),
  KIOKUKO_DATA_DIR: join(base, "data"),
  npm_config_cache: join(base, "cache"),
};
const project = join(base, "project"),
  dsh =
    process.env.DSH_BIN ??
    join(root, "tests/fixtures/dsh-runtime/node_modules/.bin/dsh"),
  bodies = [];
let host,
  browser,
  page,
  logs = "";
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const part of req) raw += part;
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "z-ai/glm-5.3",
            name: "Local GLM",
            context_length: 1024000,
            max_output_tokens: 128000,
          },
        ],
      }),
    );
    return;
  }
  const body = JSON.parse(raw);
  bodies.push(body);
  if(bodies.length===1){res.writeHead(429,{'content-type':'application/json','retry-after':'8'});res.end(JSON.stringify({error:{message:'fixture rate limit',type:'rate_limit_error'}}));return}
  const complete = body.messages.some((m) => m.role === "tool"),
    tools = body.tools?.some((t) => t.function?.name === "models_test_tool");
  const delta =
    tools && !complete
      ? {
          tool_calls: [
            {
              index: 0,
              id: "call_models",
              type: "function",
              function: { name: "models_test_tool", arguments: "{}" },
            },
          ],
        }
      : { content: complete ? "MODEL TOOL SUCCESS" : "MODEL CHAT SUCCESS" };
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    "data: " +
      JSON.stringify({
        id: "cmpl-models",
        created: 1,
        model: body.model,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", ...delta },
            finish_reason: null,
          },
        ],
      }) +
      "\n\ndata: " +
      JSON.stringify({
        id: "cmpl-models",
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: tools && !complete ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
async function poll(fn, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Models Web acceptance timed out");
}
async function stop() {
  if (host) {
    const current = host;
    host = undefined;
    current.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => current.once("exit", r)),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
  }
}
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
  for (const name of ["home", "dsh", "data", "project"])
    await mkdir(join(base, name));
  await exec("git", ["init", "-q"], { cwd: project });
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--ignore-scripts", "--pack-destination", base, "--json"],
        { cwd: root, env },
      )
    ).stdout,
  )[0].filename;
  console.log("Installing packed models fixture");
  await exec(
    dsh,
    ["plugin", "--profile", "web", "add", join(base, packed), "--force"],
    { cwd: project, env, timeout: 180000, maxBuffer: 16 * 1024 ** 2 },
  );
  const fixture = join(base, "fixture.mjs");
  await writeFile(
    fixture,
    `export const name='models-fixture';export const inject=['workspaceRegistry','tools'];export async function apply(ctx){await ctx.workspaceRegistry.create(${JSON.stringify(project)},'Models acceptance');ctx.tools.register({name:'models_test_tool',description:'Local model acceptance tool',parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},handler:async()=>({ok:true,data:'verified local tool'})});let deviceLogins=0;const realFetch=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=String(input);if(url==='https://portal.nousresearch.com/api/oauth/device/code'){deviceLogins++;return Response.json({device_code:'test-device',user_code:'TEST-CODE',verification_uri:'https://example.com/login',verification_uri_complete:'https://example.com/login?code=TEST-CODE',expires_in:600,interval:1})};if(url==='https://portal.nousresearch.com/api/oauth/token')return deviceLogins>1?Response.json({access_token:'private-oauth-access',refresh_token:'private-oauth-refresh',expires_in:3600}):Response.json({error:'authorization_pending'},{status:400});return realFetch(input,init)};ctx.effect(()=>()=>{globalThis.fetch=realFetch},'local OAuth fixture')}`,
  );
  const patch = join(env.DSH_HOME, "profiles/web/cordis.patch.yml");
  await writeFile(
    patch,
    `- id: session-title-llm\n  disabled: true\n- id: kiokuko-dsh\n  config:\n    enabled: true\n    agenticReplay: {enabled: false}\n    memoryReview: {mode: off}\n    memoryEvolution: {mode: off}\n    memoryIndexReasoning: {mode: off}\n    autoGlobalization: {enabled: false}\n- insert:\n    - id: models-fixture\n      name: ${JSON.stringify(fixture)}\n      inject: [workspaceRegistry, tools]\n`,
  );
  const boot = async () => {
    logs = "";
    host = spawn(dsh, ["--profile", "web", "--no-open", "--port", "0"], {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [host.stdout, host.stderr])
      stream.on("data", (chunk) => {
        logs += chunk;
      });
    return poll(
      () => logs.match(/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/)?.[0],
    );
  };
  let url = await boot();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL
      ? { channel: process.env.PLAYWRIGHT_CHANNEL }
      : {}),
  });
  page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on("response", async (response) => {
    if (
      response.status() >= 400 &&
      !response.url().includes("/api/kiokuko.lisp")
    )
      console.error(
        "HTTP failure",
        response.status(),
        response.url().replace(/token=[^&]+/g, "token=[redacted]"),
      );
  });
  page.on("pageerror", (error) => console.error("Browser:", error.message));
  await page.goto(url);
  const welcome = page.getByRole("button", { name: "Continue", exact: true }),
    credentials = page.getByRole("dialog", {
      name: "Add an API key to get started",
      exact: true,
    });
  await page.addLocatorHandler(credentials, async () =>
    credentials
      .getByRole("button", { name: "Configure later", exact: true })
      .click(),
  );
  await welcome.or(credentials).first().waitFor();
  if (await welcome.isVisible()) {
    for (
      let attempt = 0;
      attempt < 5 && (await welcome.isVisible());
      attempt++
    ) {
      await welcome.click();
      await new Promise((r) => setTimeout(r, 1000));
    }
    await welcome.waitFor({ state: "hidden" });
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: "Kiokuko Models", exact: true })
    .click();
  const panel = page.getByRole("region", {
    name: "Kiokuko Models",
    exact: true,
  });
  await panel.waitFor();
  await panel
    .getByLabel("Add connection", { exact: true })
    .selectOption("infron");
  await panel.getByLabel("Base URL", { exact: true }).fill(endpoint);
  let failSave=true;
  await page.route('**/api/kiokuko.models',async route=>{if(route.request().method()==='POST'&&route.request().postDataJSON().op==='save'&&failSave){failSave=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fixture save failure; retry'})})}else await route.continue()});
  await panel.getByRole('button',{name:'Save connection',exact:true}).click();
  await panel.getByRole('alert').filter({hasText:'Fixture save failure; retry'}).waitFor();
  await panel
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Connection saved" })
    .waitFor();
  await panel
    .getByLabel("API key / bearer token", { exact: true })
    .fill("private-browser-key");
  assert.equal(
    await panel
      .getByLabel("API key / bearer token", { exact: true })
      .getAttribute("type"),
    "password",
  );
  await panel.getByRole("button", { name: "Save key", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Key saved" }).waitFor();
  await panel
    .getByRole("button", { name: "Refresh models", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Default for new chats", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Default model saved" })
    .waitFor();
  await panel.getByLabel("Service tier", { exact: true }).selectOption("flex");
  await panel
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await panel
    .getByRole("status")
    .filter({ hasText: "Connection saved" })
    .waitFor();
  await page.screenshot({ path: join(base, "settings.png") });
  // Reload persists the settings and catalog; the native default is separate.
  await page.reload();
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor();
  await editor.fill("/kiokuko model");
  await editor.press("Enter");
  const dialog = page.getByRole("dialog", {
    name: "Kiokuko Models",
    exact: true,
  });
  await dialog.waitFor();
  await poll(() => dialog.evaluate((element) => element.contains(document.activeElement)));
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    assert.ok(await dialog.evaluate((element) => element.contains(document.activeElement)), "Tab must remain inside the model dialog");
  }
  const commandPanel = dialog.getByRole("region", {
    name: "Kiokuko Models",
    exact: true,
  });
  await commandPanel.getByRole("button", { name: /^Infron ·/ }).click();
  await commandPanel.getByLabel("Search models", { exact: true }).fill("glm");
  await commandPanel
    .getByRole("button", { name: "Use in current chat", exact: true })
    .click();
  await commandPanel
    .getByRole("status")
    .filter({ hasText: "Model selected for this chat" })
    .waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await poll(() => editor.evaluate((element) => document.activeElement === element), 10_000);
  await editor.fill("Say hello and call models_test_tool");
  await editor.press("Enter");
  await poll(()=>bodies.length===1);
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Kiokuko Models',exact:true}).click();
  await panel.getByRole('button',{name:/^Infron · connected/}).click();
  await panel.getByLabel('Service tier',{exact:true}).selectOption('standard');
  await panel.getByRole('button',{name:'Save connection',exact:true}).click();
  await panel.getByRole('status').filter({hasText:'Connection saved'}).waitFor();
  await page.keyboard.press('Escape');
  await page
    .getByText("MODEL TOOL SUCCESS", { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  assert.ok(
    bodies.some((body) => body.messages.some((m) => m.role === "tool")),
    "normal native agent loop must continue after a tool result",
  );
  assert.equal(bodies[0].provider.service_tier,'flex');
  assert.equal(bodies[1].provider.service_tier,'flex','native retry must preserve the first attempt tier');
  assert.ok(bodies.slice(2).every(body=>body.provider.service_tier==='standard'),'the next tool-result request observes the saved tier');
  assert.ok(bodies.every((body) => !body.extra_body));
  await editor.fill("/kiokuko model");
  await editor.press("Enter");
  await dialog.waitFor();
  await commandPanel
    .getByLabel("Add connection", { exact: true })
    .selectOption("nous");
  await commandPanel
    .getByRole("button", { name: "Log in", exact: true })
    .click();
  await commandPanel.getByText("Code: TEST-CODE", { exact: true }).waitFor();
  await commandPanel
    .getByRole("button", { name: "Cancel authentication", exact: true })
    .click();
  await commandPanel
    .getByRole("status")
    .filter({ hasText: "Authentication cancelled" })
    .waitFor();
  await commandPanel.getByRole('button',{name:'Log in',exact:true}).click();
  await commandPanel.getByRole('button',{name:/^Nous \/ Hermes · connected/}).waitFor();
  await commandPanel.getByRole('button',{name:'Log out (also dsh-cli)',exact:true}).click();
  await commandPanel.getByRole('button',{name:/^Nous \/ Hermes · disconnected/}).waitFor();
  await commandPanel.getByRole('button',{name:'Log in',exact:true}).click();
  await commandPanel.getByRole('button',{name:/^Nous \/ Hermes · connected/}).waitFor();
  await page.screenshot({ path: join(base, "command.png") });
  await page.keyboard.press("Escape");
  await stop();
  url = await boot();
  await page.goto(url);
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    try {
      await page
        .getByRole("button", { name: "Kiokuko Models", exact: true })
        .click({ timeout: 3000 });
      await panel
        .getByRole("button", { name: /^Infron · connected/ })
        .waitFor({ timeout: 3000 });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  assert.ok(!logs.includes("private-browser-key"));
  console.log(
    JSON.stringify({
      passed: true,
      packed,
      requests: bodies.length,
      scenarios: [
        "empty native configuration",
        "Settings",
        "exact command",
        "masked key",
        "refresh/search",
        "current/default selection",
        "native retry and tier changes",
        "native tool continuation",
        "OAuth device cancellation and fixture re-login/logout",
        "save failure",
        "browser reload",
        "host restart",
      ],
      evidence: base,
    }),
  );
} catch (error) {
  if (page) {
    console.error(await page.locator("body").ariaSnapshot());
    await page.screenshot({ path: join(base, "failure.png") });
  }
  console.error(logs.slice(-7000).replace(/token=[^\s]+/g, "token=[redacted]"));
  console.error("Evidence", base);
  throw error;
} finally {
  await browser?.close();
  await stop();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  if (process.env.KIOKUKO_KEEP_MODELS_EVIDENCE !== "1")
    await rm(base, { recursive: true, force: true });
}
