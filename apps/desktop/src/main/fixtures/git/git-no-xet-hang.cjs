'use strict'
// Todo 28 QA failure fixture: Git-Xet is missing AND the credential.helper
// config probe HANGS. The bounded runner must yield a typed `missing` for
// git.xet and a typed `timeout` for git.credentials without hanging the app.
const args = process.argv.slice(2)
if (args.some((a) => a === 'install')) {
  process.stderr.write('MUTATION GUARD: install was requested\n')
  process.exit(99)
}
const sub = args[0]
if (sub === '--version') {
  process.stdout.write('git version 2.47.0.windows.1\n')
  process.exit(0)
}
if (sub === 'xet') {
  process.stderr.write("git: 'xet' is not a git command. See 'git --help'.\n")
  process.exit(1)
}
if (sub === 'config') {
  if (args.includes('--get-regexp')) {
    process.exit(1)
  }
  if (args.includes('--get-all')) {
    setInterval(() => undefined, 1_000_000)
    return
  }
  process.exit(1)
}
if (sub === 'credential-manager' && args[1] === 'version') {
  process.stderr.write("git: 'credential-manager' is not a git command.\n")
  process.exit(1)
}
process.stderr.write('fatal: not a git command\n')
process.exit(1)
