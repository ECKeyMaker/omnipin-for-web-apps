import * as assert from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { JSDOM } from 'jsdom'

// Mounts the built panel, because unit tests can't see bundling mistakes. This
// suite exists because classic JSX in dist/react.js once crashed on first
// render while every unit test passed.

const dom = new JSDOM('<!doctype html><div id="root"></div>', {
  url: 'https://app.test/',
})
const realFetch = globalThis.fetch

Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
})

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToString } = await import('react-dom/server')
const { DeployPanel } = await import('../dist/react.js')

const props = { apiBase: 'https://gateway.test', getToken: () => 'token' }

const setInput = (input: HTMLInputElement, value: string) => {
  const descriptor = Object.getOwnPropertyDescriptor(
    dom.window.HTMLInputElement.prototype,
    'value',
  )
  descriptor?.set?.call(input, value)
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

const selectFiles = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, 'files', { value: files, configurable: true })
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

const mount = async (extra: object = {}) => {
  document.body.innerHTML = '<div id="root"></div>'
  const root = createRoot(document.getElementById('root') as HTMLElement)
  await act(async () =>
    root.render(createElement(DeployPanel, { ...props, ...extra })),
  )
  return root
}

const query = <T extends Element>(selector: string) =>
  document.querySelector(selector) as T

before(() => {
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url)
    if (target.includes('storage')) return new Response(null, { status: 200 })
    if (target.endsWith('/') && init.method === 'POST')
      return Response.json(
        {
          id: '1',
          uploadUrl: 'https://storage.test/put',
          contentType: 'application/vnd.ipld.car',
        },
        { status: 201 },
      )
    if (target.endsWith('/start')) return Response.json({}, { status: 202 })
    return Response.json({
      id: '1',
      status: 'published',
      providers: [{ name: 'Pinata', status: 'deployed', pin: 'pinned' }],
      ens: null,
      urls: { gateway: 'https://site.ipfs.dweb.link/' },
      error: null,
    })
  }) as typeof fetch
})

after(() => {
  globalThis.fetch = realFetch
})

describe('DeployPanel', () => {
  it('renders on the server', () => {
    const html = renderToString(createElement(DeployPanel, props))
    assert.ok(html.includes('type="file"'))
  })

  it('deploys a selected file and shows the result', async () => {
    let deployed = (_: unknown) => {}
    const finished = new Promise((resolve) => {
      deployed = resolve
    })

    await mount({ onDeployed: deployed })

    const submit = query<HTMLButtonElement>('button[type=submit]')
    assert.strictEqual(submit.disabled, true)

    await act(async () =>
      setInput(query<HTMLInputElement>('input[required]'), 'hello'),
    )
    await act(async () =>
      selectFiles(query<HTMLInputElement>('input[type=file]'), [
        new File(['<h1>hi</h1>'], 'index.html'),
      ]),
    )
    assert.strictEqual(
      query<HTMLButtonElement>('button[type=submit]').disabled,
      false,
    )

    await act(async () => {
      query('form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )
      await finished
    })

    assert.strictEqual(
      query<HTMLAnchorElement>('[role=status] a').href,
      'https://site.ipfs.dweb.link/',
    )
    assert.strictEqual(query('[role=alert]'), null)
  })

  it('reports a site it refuses to publish', async () => {
    await mount()

    await act(async () =>
      setInput(query<HTMLInputElement>('input[required]'), 'hello'),
    )
    await act(async () =>
      selectFiles(query<HTMLInputElement>('input[type=file]'), [
        new File(['<h1>hi</h1>'], 'index.html'),
        new File(['SECRET=1'], '.env'),
      ]),
    )
    await act(async () => {
      query('form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    assert.match(query('[role=alert]').textContent ?? '', /secrets/)
  })
})
