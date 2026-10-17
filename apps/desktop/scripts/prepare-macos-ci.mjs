/** Validate machine-owned macOS signing settings and record a manual Actions build version. */
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { desktopCiVersion } from './desktop-ci-version.mjs'
import { loadDesktopPackageEnvironment, validateDesktopPackageEnvironment } from './desktop-package-environment.mjs'

const appRoot = resolve(import.meta.dirname, '..')
const product = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'))
const version = desktopCiVersion(process.env, product.version)
if (!process.env.DSH_PACKAGING_PRESET) throw new Error('Select a machine preset')
const skipNotarization = process.env.PACKAGE_SKIP_NOTARIZATION === 'true'
if (!['true', 'false', undefined].includes(process.env.PACKAGE_SKIP_NOTARIZATION)) throw new Error('Invalid skip notarization selection')
const adHocSigning = process.env.PACKAGE_HOSTED === 'true'
if (!['true', 'false', undefined].includes(process.env.PACKAGE_HOSTED)) throw new Error('Invalid hosted packaging selection')
if (adHocSigning && !skipNotarization) throw new Error('Hosted macOS packaging requires skipped notarization')
const environment = loadDesktopPackageEnvironment('darwin', process.env, appRoot, { skipNotarization, adHocSigning })
for (const [name, value] of Object.entries(environment)) {
  if (/KEY|TOKEN|PASSWORD|SECRET|APPLE_ID/iu.test(name) && value) {
    const escaped = value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
    process.stdout.write(`::add-mask::${escaped}\n`)
  }
}
validateDesktopPackageEnvironment(environment, { platform: 'darwin', arch: 'arm64' }, { skipNotarization, adHocSigning })
if (!process.env.GITHUB_OUTPUT || !process.env.GITHUB_STEP_SUMMARY) throw new Error('Run this adapter from GitHub Actions')
// Ad-hoc signing prints the distribution layout; a skipped notarization with a certificate keeps the debug layout.
appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\nartifacts=${adHocSigning || !skipNotarization ? 'artifacts' : 'unnotarized-artifacts'}\nmode=${adHocSigning ? 'unnotarized-ad-hoc' : skipNotarization ? 'unnotarized-debug' : 'signed'}\n`)
appendFileSync(process.env.GITHUB_STEP_SUMMARY, `macOS arm64 signed installer\n\nVersion: ${version}\n\nCommit: ${execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()}\n\nChannel: ${process.env.DSH_DESKTOP_UPDATE_CHANNEL}\n\nSource: ${process.env.PACKAGE_SOURCE_REF}\n\nPreset: ${process.env.DSH_PACKAGING_PRESET}\n`)
if (skipNotarization) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\nWARNING: ${adHocSigning ? 'ad-hoc signed' : 'signed'} but NOT notarized or stapled. Internal debugging only; Gatekeeper may block downloaded copies. Not qualified for distribution or update publishing.\n`)
