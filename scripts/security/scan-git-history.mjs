import { execFileSync } from 'node:child_process'

const patterns = [
  { name: 'OpenAI-style API key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]

function scan(label, text) {
  const findings = []
  for (const { name, re } of patterns) {
    re.lastIndex = 0
    let match
    while ((match = re.exec(text)) != null) {
      findings.push({ label, name, sample: match[0].slice(0, 8) + '…' })
      if (findings.length >= 25) break
    }
  }
  return findings
}

const history = execFileSync(
  'git',
  ['log', '-p', '--all', '--full-history', '--no-ext-diff', '--no-textconv'],
  { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 }
)

const findings = scan('git history', history)

if (findings.length) {
  console.error('Potential secret material found in repository history:')
  for (const finding of findings) {
    console.error(`- ${finding.name} in ${finding.label}: ${finding.sample}`)
  }
  process.exit(1)
}

console.log('Security secret-history scan passed: no high-confidence secret token patterns found.')
