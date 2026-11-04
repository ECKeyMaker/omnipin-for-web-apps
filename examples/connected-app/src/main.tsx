import { DeployPanel } from 'omnipin-web-apps/react'
import { createRoot } from 'react-dom/client'

const getToken = async () => {
  const res = await fetch('/api/omnipin-token', { method: 'POST' })
  if (!res.ok) throw new Error('Sign in to deploy')
  return res.text()
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <main>
    <h1>Deploy a site</h1>
    <DeployPanel
      apiBase="https://gateway.example/api/deployments"
      appId="your-app"
      getToken={getToken}
      ens
    />
  </main>,
)
