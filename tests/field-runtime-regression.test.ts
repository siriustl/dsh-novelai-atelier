import { afterEach, describe, expect, it } from 'vitest'
import * as React18 from 'react18'
import * as React19 from 'react'
import { Field, setReact, type ReactLike } from '../client/ui.tsx'

const children = (node: any): any[] => Array.isArray(node.props.children) ? node.props.children : [node.props.children]

describe.each([['host React 18.3.1', React18], ['React 19', React19]])('%s field compatibility', (_name, runtime) => {
  afterEach(() => setReact(React19 as unknown as ReactLike))

  it('preserves DOM refs, keys and handlers when attaching a label', () => {
    setReact(runtime as unknown as ReactLike)
    const ref = () => {}
    const onChange = () => {}
    const input = runtime.createElement('input', { key: 'credential', ref, type: 'password', defaultValue: 'synthetic', onChange })
    const field = Field({ label: 'Credential', hint: 'Private' }, input)
    const [label, control] = children(field)
    // React 18 stores ref on the element, React 19 stores it in props.
    expect(Object.getOwnPropertyDescriptor(control.props, 'ref')?.value ?? control.ref).toBe(ref)
    expect(control.key).toBe('credential')
    expect(control.props.onChange).toBe(onChange)
    expect(control.props.defaultValue).toBe('synthetic')
    expect(control.props.id).toBe(label.props.htmlFor)
    expect(control.props['aria-describedby']).toBe(`${control.props.id}-hint`)
  })

  it('retains select children and explicit input ids', () => {
    setReact(runtime as unknown as ReactLike)
    const options = runtime.createElement('option', { value: 'one' }, 'One')
    const select = runtime.createElement('select', { id: 'stable-control' }, options)
    const [label, control] = children(Field({ label: 'Choice' }, select))
    expect(control.props.children).toBe(options)
    expect(control.props.id).toBe('stable-control')
    expect(label.props.htmlFor).toBe('stable-control')
  })
})
