import { PROVIDERS } from '../constants.js'
import { statusOnFilecoin, uploadToFilecoin } from './ipfs/filecoin.js'
import { uploadOnHoverfly } from './swarm/hoverfly.js'

// Providers that only work on Node, so only Node entry points register them.
// Keeping them out of `constants.ts` keeps their Node built-ins out of the
// browser and Worker bundles.
//
// Hoverfly talks to a local daemon over a UNIX socket (`node:net`). Filecoin's
// SDK imports `node:crypto`, and its token is a raw private key that shouldn't
// be held by a web app in any case.
PROVIDERS.FILECOIN_TOKEN = {
  name: 'Filecoin',
  upload: uploadToFilecoin,
  status: statusOnFilecoin,
  supported: 'both',
  protocol: 'ipfs',
}

PROVIDERS.HOVERFLY_TOKEN = {
  name: 'Hoverfly',
  upload: uploadOnHoverfly,
  supported: 'upload',
  protocol: 'swarm',
}
