import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'dist')
if (!fs.existsSync(root)) {
  console.error(`Built asset directory does not exist: ${root}`)
  process.exit(1)
}

const textExtensions = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.json', '.map', '.txt', '.svg'])
const patterns = [
  { name: 'Supabase service-role environment identifier', re: /\bSUPABASE_SERVICE_ROLE_KEY\b/g },
  { name: 'Resend server environment identifier', re: /\bRESEND_API_KEY\b/g },
  { name: 'Groq server environment identifier', re: /\bGROQ_API_KEY\b/g },
  { name: 'Supabase secret key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g },
  { name: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { name: 'Resend API key', re: /\bre_[A-Za-z0-9_-]{30,}\b/g },
  { name: 'Private key material', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
]

function filesUnder(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...filesUnder(full))
    else if (textExtensions.has(path.extname(entry.name))) out.push(full)
  }
  return out
}

const findings = []
for (const file of filesUnder(root)) {
  const text = fs.readFileSync(file, 'utf8')
  for (const pattern of patterns) {
    pattern.re.lastIndex = 0
    let match
    while ((match = pattern.re.exec(text)) != null) {
      findings.push({
        file: path.relative(process.cwd(), file),
        kind: pattern.name,
        sample: match[0].slice(0, 10) + '…',
      })
      if (findings.length >= 50) break
    }
  }
}

if (findings.length) {
  console.error('Server-only secret material or identifiers found in built browser assets:')
  for (const finding of findings) {
    console.error(`- ${finding.kind} in ${finding.file}: ${finding.sample}`)
  }
  process.exit(1)
}

console.log('Built-asset secret scan passed: no server-only secret identifiers or high-confidence key formats found.')
