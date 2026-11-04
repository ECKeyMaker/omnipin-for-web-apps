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
      selectFiles(query<HTMLInputElement>('input[data-kind=files]'), [
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

  it('reviews a selection, then refuses secrets before anything uploads', async () => {
    let requests = 0
    const previous = globalThis.fetch
    globalThis.fetch = (async () => {
      requests++
      return new Response()
    }) as typeof fetch

    await mount()

    await act(async () =>
      selectFiles(query<HTMLInputElement>('input[data-kind=files]'), [
        new File(['<h1>hi</h1>'], 'index.html'),
      ]),
    )
    assert.match(query('[data-testid=review]').textContent ?? '', /1 file/)

    await act(async () =>
      selectFiles(query<HTMLInputElement>('input[data-kind=files]'), [
        new File(['<h1>hi</h1>'], 'index.html'),
        new File(['SECRET=1'], '.env'),
      ]),
    )

    assert.match(query('[role=alert]').textContent ?? '', /secrets/)
    assert.strictEqual(query('[data-testid=review]'), null)
    assert.strictEqual(
      query<HTMLButtonElement>('button[type=submit]').disabled,
      true,
    )
    assert.strictEqual(requests, 0)
    globalThis.fetch = previous
  })

  it('offers a folder picker', async () => {
    await mount()
    assert.ok(query('input[data-kind=folder]').hasAttribute('webkitdirectory'))
  })

  it('walks through the ENS update with a wallet', async () => {
    const previous = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      const target = String(url)
      if (target.endsWith('/sponsorship'))
        return Response.json({
          call: { to: `0x${'cc'.repeat(20)}`, data: '0x12' },
          sponsored: false,
        })
      if (target.endsWith('/ens/verify'))
        return Response.json({ confirmed: true })
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
        providers: [],
        ens: { name: 'site.eth', status: null },
        urls: { gateway: 'https://site.ipfs.dweb.link/' },
        error: null,
      })
    }) as typeof fetch

    const methods: string[] = []
    const wallet = {
      request: async ({ method }: { method: string }) => {
        methods.push(method)
        return method === 'eth_requestAccounts'
          ? [`0x${'aa'.repeat(20)}`]
          : '0xhash'
      },
    }

    let deployed = (_: unknown) => {}
    const finished = new Promise((resolve) => {
      deployed = resolve
    })
    await mount({ ens: true, wallet, onDeployed: deployed })

    await act(async () =>
      setInput(query<HTMLInputElement>('input[required]'), 'hello'),
    )
    await act(async () =>
      selectFiles(query<HTMLInputElement>('input[data-kind=files]'), [
        new File(['<h1>hi</h1>'], 'index.html'),
      ]),
    )
    await act(async () => {
      query('form').dispatchEvent(
        new dom.window.Event('submit', { bubbles: true, cancelable: true }),
      )
      await finished
    })

    const update = Array.from(document.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('site.eth'),
    )
    assert.ok(update, 'expected an ENS button once published')

    await act(async () => {
      update.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true }),
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    assert.deepStrictEqual(methods, [
      'eth_requestAccounts',
      'eth_sendTransaction',
    ])
    assert.match(
      query('[role=status]').textContent ?? '',
      /ENS name updated.*paid by your wallet/,
    )
    globalThis.fetch = previous
  })
})
