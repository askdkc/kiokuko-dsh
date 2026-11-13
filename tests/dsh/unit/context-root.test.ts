import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { contextRoot } from '../../../src/dsh/context-root.js'

test('root lookup resolves real Cordis child contexts to their shared host root', () => {
  const root = new Context()
  assert.equal(contextRoot(root), root)
  assert.equal(contextRoot(root.extend().extend()), root)
  assert.equal(contextRoot(root.isolate('test-service')), root)
})

test('symbol root takes precedence without reading a legacy service property', () => {
  const previous = Object.getOwnPropertyDescriptor(Context, 'root')
  const key = Symbol('root')
  Object.defineProperty(Context, 'root', { configurable: true, value: key })
  try {
    const root = {} as Context
    const child = { [key]: root, get root() { throw new Error('must not read a service named root') } } as unknown as Context
    assert.equal(contextRoot(child), root)
    const standalone = {} as Context
    assert.equal(contextRoot(standalone), standalone)
  } finally {
    if (previous) Object.defineProperty(Context, 'root', previous)
    else Reflect.deleteProperty(Context, 'root')
  }
})

test('legacy root and contexts without root retain their existing behavior', () => {
  const previous = Object.getOwnPropertyDescriptor(Context, 'root')
  Object.defineProperty(Context, 'root', { configurable: true, value: undefined })
  try {
    const root = {} as Context
    assert.equal(contextRoot({ root } as unknown as Context), root)
    const standalone = {} as Context
    assert.equal(contextRoot(standalone), standalone)
  } finally {
    if (previous) Object.defineProperty(Context, 'root', previous)
    else Reflect.deleteProperty(Context, 'root')
  }
})
