import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const script = fileURLToPath(new URL('../scripts/read-desktop-app-key.mjs', import.meta.url))
const { APP_KEY_FILE: _ignoredKeyFile, ...restEnvironment } = process.env

it('masks multiline key bytes and passes the exact fixture to the token action without a shell', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-app-key-'))
  try {
    const path = join(root, 'fixture.pem')
    const output = join(root, 'output')
    const key = 'fixture%key\r\nsecond-line\n'
    await writeFile(path, key)
    const result = await promisify(execFile)(process.execPath, [script], {
      env: { ...restEnvironment, APP_KEY_FILE: path, GITHUB_OUTPUT: output }, encoding: 'utf8',
    })
    expect(result.stdout).toBe('::add-mask::fixture%25key%0D%0Asecond-line%0A\n')
    expect(result.stderr).toBe('')
    const contents = await readFile(output, 'utf8')
    const delimiter = contents.slice('private-key<<'.length, contents.indexOf('\n'))
    expect(contents).toBe(`private-key<<${delimiter}\n${key}\n${delimiter}\n`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('prefers the Environment key over an App key file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-app-key-'))
  try {
    const path = join(root, 'fixture.pem')
    const output = join(root, 'output')
    await writeFile(path, 'file-key\n')
    const result = await promisify(execFile)(process.execPath, [script], {
      env: { ...restEnvironment, APP_KEY_FILE: path, DSH_GITHUB_APP_PRIVATE_KEY: 'environment-key\n', GITHUB_OUTPUT: output },
      encoding: 'utf8',
    })
    expect(result.stdout).toBe('::add-mask::environment-key%0A\n')
    expect(await readFile(output, 'utf8')).toContain('environment-key\n')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('fails without writing an output when neither the Environment key nor an App key file is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-app-key-'))
  try {
    const output = join(root, 'output')
    await writeFile(output, '')
    const failure: unknown = await promisify(execFile)(process.execPath, [script], {
      env: { ...restEnvironment, DSH_GITHUB_APP_PRIVATE_KEY: '', APP_KEY_FILE: '', GITHUB_OUTPUT: output }, encoding: 'utf8',
    }).then(() => undefined, (error: unknown) => error)
    expect(failure).toMatchObject({
      code: 1, stderr: 'Desktop publication: cannot hand the configured App key to the token action.\n',
    })
    expect(await readFile(output, 'utf8')).toBe('')
  } finally { await rm(root, { recursive: true, force: true }) }
})
