import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import cmuxIntegration from './src/cmuxIntegration.ts'
import registerPermissionNotify from './src/permissionNotify.ts'
import registerAskUserNotify from './src/askUserNotify.ts'

export * from './src/cmux.ts'

export default function piCmux(pi: ExtensionAPI) {
  cmuxIntegration(pi)
  registerPermissionNotify(pi)
  registerAskUserNotify(pi)
}
