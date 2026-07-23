import SkipLink from './ui/SkipLink'
import SiteHeader from './sections/SiteHeader'
import Hero from './sections/Hero'
import Problem from './sections/Problem'
import MeetDuewatch from './sections/MeetDuewatch'
import Evidence from './sections/Evidence'
import Presence from './sections/Presence'
import Bridge from './sections/Bridge'
import GlobalVision from './sections/GlobalVision'
import Pricing from './sections/Pricing'
import FinalCta from './sections/FinalCta'
import SiteFooter from './sections/SiteFooter'
import './tokens/tokens.css'

// Phase 1: static, responsive, semantic markup only. No motion, no cinematic
// sequences, no globe geometry, no early-access wiring — see
// DUEWATCH_CONTEXT_LOG.md for what's deliberately deferred and why.
export default function LandingPage() {
  return (
    <div id="top" className="landingRoot">
      <SkipLink />
      <SiteHeader />
      <main id="main-content">
        <Hero />
        <Problem />
        <MeetDuewatch />
        <Evidence />
        <Presence />
        <Bridge />
        <GlobalVision />
        <Pricing />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  )
}
