'use strict'
// Todo 28 fixture: a plaintext `store` credential helper is configured.
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
  if (args[1] === 'version' || args[1] === '--version') {
    process.stdout.write('git-xet version 0.14.0\n')
    process.exit(0)
  }
  process.exit(1)
}
if (sub === 'config') {
  if (args.includes('--get-regexp')) {
    process.stdout.write('file:C:/Users/alice/.gitconfig\tfilter.xet.process\tgit-xet filter\n')
    process.exit(0)
  }
  if (args.includes('--get-all')) {
    process.stdout.write('file:C:/Users/alice/.gitconfig\tstore\n')
    process.exit(0)
  }
  process.exit(1)
}
if (sub === 'credential-manager' && args[1] === 'version') {
  process.stdout.write('Git Credential Manager version 2.5.1\n')
  process.exit(0)
}
process.stderr.write('fatal: not a git command\n')
process.exit(1)
