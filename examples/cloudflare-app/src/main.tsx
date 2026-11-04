import { DeployPanel } from 'omnipin-web-apps/react'
import { createRoot } from 'react-dom/client'

// Same origin as the Worker, so your app's login cookie goes along by itself.
createRoot(document.getElementById('root') as HTMLElement).render(
  <main>
    <h1>Deploy a site</h1>
    <DeployPanel apiBase="/api/deployments" ens />
  </main>,
)
