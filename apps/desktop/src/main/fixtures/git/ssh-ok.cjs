'use strict'
// Todo 28 fixture: an OpenSSH client responding to `ssh -V` with a version on
// stderr (Windows OpenSSH quirk: version on stderr, nonzero exit tolerated —
// the service classifies by version presence).
const args = process.argv.slice(2)
if (args[0] === '-V') {
  process.stderr.write('OpenSSH_9.8p1 for Windows\n')
  process.exit(1)
}
process.stderr.write('usage: ssh [-46AaCfGgKkMNnqsTtVvXxYy] ...\n')
process.exit(1)
