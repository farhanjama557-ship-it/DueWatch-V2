// All landing-page copy, verbatim from the Unified Landing-Page
// Specification §4 and the Final Visual Specification v2, where the two
// agree. Written product truth overrides generated-image text; nothing here
// was invented to fill a gap — see productTruthLedger.js for what's
// deliberately absent and why.

export const header = {
  wordmark: 'Duewatch',
  nav: [
    { label: 'How it works', href: '#employee-moment' },
    { label: 'Evidence', href: '#evidence' },
    { label: 'Presence', href: '#presence' },
    { label: 'Principles', href: '#bridge' },
    { label: 'Pricing', href: '#pricing' },
  ],
  primaryAction: { label: 'Get early access', href: '#final-cta' },
}

export const hero = {
  eyebrow: 'Your accounts receivable employee',
  headline: ['You do the work.', 'Duewatch makes sure you get paid.'],
  supporting:
    'Duewatch runs one invoice check each day, drafts the follow-up, and brings you anything that needs a decision. Review it, edit it, or skip it before it leaves review mode.',
  approvalClarification:
    'Prefer fewer approvals? Automatic sending is optional and follows rules you set.',
  primaryCta: 'Get early access',
  secondaryCta: 'See how it works',
  trustLine: 'No credit card required.',
  demoLabel: 'Interactive demo · Illustrative data',
  duewatchStatus: 'I drafted a Professional reminder using your 5-day follow-up rule.',
  actions: ['Approve & Send', 'Edit First', 'Skip'],
  postActionStatuses: ['Signing…', 'Sending…', 'Sent'],
}

export const problem = {
  label: 'The part nobody wants to own',
  thoughts: [
    'My client still hasn’t paid.',
    'How do I ask again without sounding rude?',
    'Did they even open the reminder?',
    'Maybe my work wasn’t worth what I charged.',
  ],
  resolution: ['The work is finished.', 'The follow-through shouldn’t still be yours.'],
}

export const meetDuewatch = {
  label: 'A quiet daily handoff',
  title: 'Meet Duewatch.',
  supportingLine: 'Your accounts receivable employee is already at work.',
  principle: 'Motion shows what I’m doing. Stillness means everything is handled.',
  aiMention:
    'Duewatch is an AI accounts receivable employee for freelancers and small agencies. It moves the next task forward, then gets out of the way.',
  morningBrief: {
    greeting: 'Good morning.',
    lines: [
      'I ran today’s invoice check.',
      'Marlow & Co needs a follow-up.',
      'I drafted a Professional reminder.',
      'It’s waiting for your signature.',
    ],
    closing: 'Everything else needs no action today.',
  },
  labels: ['Awaiting your signature', 'Review draft', 'Edit', 'Skip', 'Autopilot is on', 'Next check tomorrow'],
  demoLabel: 'Interactive demonstration',
  journeyBar: ['Checked', 'Drafted', 'Signature', 'Sent', 'Paid'],
  replayLabel: 'Replay introduction',
  exploreLabel: 'Explore it yourself',
}

export const evidence = {
  label: 'The work log',
  headline: 'Nothing happens silently.',
  supporting:
    'Every check, draft, decision, send, skip, and failure leaves a timestamped reason. Not a stream of notifications—a record of the work.',
}

export const presence = {
  label: 'Presence, not noise',
  headline: 'Seven states. One clear meaning each.',
  supporting: 'Duewatch moves only when movement tells you something. Most of the time, it should be still.',
  closingLine: 'Stillness is the default.',
}

export const bridge = {
  label: 'The Bridge',
  opening: [
    'There is a gap between finishing the work and receiving the money.',
    'It exists in every industry.',
    'In every country.',
    'At every size of business.',
    'The smaller the business, the wider that gap feels.',
  ],
  asymmetry: ['A large company absorbs a late invoice.', 'A freelancer restructures their month around it.'],
  primaryStatement: 'Businesses should not have to beg to be paid for work they already completed.',
  resolution: 'Duewatch exists to close that gap.',
  principles: [
    {
      title: 'Trust before autonomy',
      body: 'Duewatch earns responsibility; it doesn’t assume it. You choose what requires approval and what may send automatically under rules you set.',
    },
    {
      title: 'Action before analytics',
      body: 'Move the invoice toward payment first. Charts about it are secondary—and usually unnecessary.',
    },
    {
      title: 'Every action leaves evidence',
      body: 'Checks, drafts, approvals, sends, skips, and failures remain visible with their reasons.',
    },
    {
      title: 'Nothing happens silently',
      body: 'If Duewatch acts, you can see what it did and why.',
    },
    {
      title: 'Stillness is the default',
      body: 'Most days should be quiet. Duewatch reduces your attention instead of competing for it.',
    },
  ],
  promise: [
    'I will never act silently.',
    'I will show you what I did, and why.',
    'I will ask when your judgment matters.',
    'I will quietly handle everything else.',
  ],
  productTruth: {
    availableLabel: 'Available now',
    available:
      'A daily Morning Brief, founder-configured Autopilot rules, draft review or automatic sending, real email delivery, per-invoice pause, reminder tones, JourneyBar lifecycle stages, a timestamped work log, and manual payment recording.',
    roadmapLabel: 'Roadmap — not shipped',
    roadmap:
      'Duewatch Memory will learn how each client pays and adapt tone and timing. Later work may include payment prediction, risk scoring, SMS escalation, payment plans, bank connections, contract-to-invoice parsing, and white-label tools for accounting firms.',
  },
}

export const globalVision = {
  label: 'OUR GLOBAL VISION',
  opening: ['Work crosses borders.', 'So does waiting to be paid.'],
  lockedLine: ['The language changes.', 'The currency changes.', 'The problem never does.'],
  vision: 'We’re building Duewatch for the independent businesses caught in that silence.',
  truthLabel: 'Illustrating a global problem—not current language availability.',
}

export const pricing = {
  label: 'Pricing',
  headline: 'Start simply. Choose more when you need it.',
  supporting: 'Free and Pro are planned. Final prices and plan limits will be confirmed before launch.',
  free: {
    label: 'Details coming before launch',
    body: 'A practical way to begin with Duewatch.',
    detail: 'Exact invoice limits, reminder limits, and included features are founder decisions.',
    cta: 'Get early access',
  },
  pro: {
    label: 'Details coming before launch',
    body: 'The complete current Duewatch workflow for founders with more follow-through to manage.',
    features: [
      'Once-daily Autopilot checks',
      'Founder-configured reminder rules',
      'Review each reminder or choose automatic sending',
      'Friendly, Professional, Firm, and Final Notice tones',
      'Per-invoice Autopilot pause',
      'JourneyBar and timestamped work log',
      'Manual payment recording',
    ],
    cta: 'Get early access',
  },
  trialLine: 'The trial will be available to everyone. No credit card required.',
}

export const finalCta = {
  headline: 'Stop chasing invoices.',
  supporting:
    'Let Duewatch handle the follow-through—one daily check, one clear brief, and your decision when it matters.',
  formLabel: 'Email address',
  placeholder: 'you@company.com',
  button: 'Get early access',
  privacyLine: 'Early-access updates only. No credit card.',
  successMessage: 'You’re on the list. We’ll let you know when early access opens.',
}

export const footer = {
  brandLine: ['Duewatch', 'The accounts receivable employee who follows through.'],
  links: ['Principles', 'Pricing'], // Privacy/Terms omitted until real destinations exist
}
