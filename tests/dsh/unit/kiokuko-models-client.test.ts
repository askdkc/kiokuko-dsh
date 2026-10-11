import assert from "node:assert/strict";
import test from "node:test";
import { apply } from "../../../src/client.js";
import { mountModelsClient } from "../../../src/models-client.js";

test("Kiokuko model management is available in Settings before a model is configured", () => {
  const globals = globalThis as any,
    previous = globals.createSnapshotStore;
  globals.createSnapshotStore = (initial: unknown) => ({
    getSnapshot: () => initial,
    update() {},
  });
  const slots: any[] = [];
  try {
    apply({
      locale: { register() {} },
      uiConversation: { events: { register() {} } },
      effect() {},
      on() {},
      slots: {
        inject(_name, run) {
          run();
        },
        register(definition, component) {
          slots.push({ definition, component });
        },
      },
    });
    const section = slots.find(
      (row) =>
        row.definition.name === "settings.section" &&
        row.definition.id === "kiokuko-models",
    );
    assert.ok(
      section,
      "Settings must contain the Kiokuko Models section without any LLM connection",
    );
    assert.equal(typeof section.component, "function");
  } finally {
    if (previous === undefined) delete globals.createSnapshotStore;
    else globals.createSnapshotStore = previous;
  }
});

test("command dialog restores focus through the current retained session input and releases pending focus on unload", () => {
  const globals = globalThis as any;
  const previous = [globals.createSnapshotStore, globals.requestAnimationFrame, globals.cancelAnimationFrame];
  const slots: any[] = [], frames = new Map<number, () => void>();
  let focusCount = 0, sequence = 0, disposeFocus: (() => void) | undefined;
  const scope = { get: () => ({ input: { for: (actual: unknown) => {
    assert.equal(actual, scope);
    return { focus: () => focusCount++ };
  } } }) };
  globals.createSnapshotStore = (initial: unknown) => ({ getSnapshot: () => initial, update: (change: any) => change(initial) });
  globals.requestAnimationFrame = (callback: () => void) => { frames.set(++sequence, callback); return sequence };
  globals.cancelAnimationFrame = (id: number) => frames.delete(id);
  try {
    mountModelsClient({
      get: () => ({ scope: (id: string) => { assert.equal(id, "chat-a"); return scope } }),
      locale: { register() {} }, on() {},
      effect(setup, label) { if (label === "kiokuko models focus lifecycle") disposeFocus = setup() as () => void },
      slots: { inject(_name, mount) { mount() }, register(definition) { slots.push(definition) } },
    });
    slots.find((s) => s.id === "kiokuko-models-dialog").inject().activeModelsSession.current = "chat-a";
    const close = slots.find((s) => s.id === "kiokuko-models-overlay").inject().closeModels;
    close();
    frames.get(sequence)!();
    frames.delete(sequence);
    assert.equal(focusCount, 1);
    close();
    disposeFocus!();
    assert.equal(frames.size, 0);
  } finally {
    for (const [index, name] of ["createSnapshotStore", "requestAnimationFrame", "cancelAnimationFrame"].entries()) {
      if (previous[index] === undefined) delete globals[name]; else globals[name] = previous[index];
    }
  }
});
