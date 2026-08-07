import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X } from 'lucide-react'
import {
  parseUpload,
  buildSheetView,
  createInitialMapping,
  validateMapping,
  invalidateDateDecisions,
  normalizeParsedUpload,
} from '../lib/importUiAdapter.js'
import { IGNORE_KEY } from '../lib/import/fields.js'
import { needsDateDecisionStep, needsCurrencyStep } from '../lib/importUiCopy.js'
import importHeroImg from '../assets/duewatch-import-hero.svg'
import StepProgress from '../components/import/StepProgress.jsx'
import UploadStep from '../components/import/UploadStep.jsx'
import ParsingStep from '../components/import/ParsingStep.jsx'
import FileErrorStep from '../components/import/FileErrorStep.jsx'
import SheetStep from '../components/import/SheetStep.jsx'
import HeaderStep from '../components/import/HeaderStep.jsx'
import MappingStep from '../components/import/MappingStep.jsx'
import DatesStep from '../components/import/DatesStep.jsx'
import CurrencyStep from '../components/import/CurrencyStep.jsx'
import PreviewStep from '../components/import/PreviewStep.jsx'
import ReviewStep from '../components/import/ReviewStep.jsx'
import RejectedStep from '../components/import/RejectedStep.jsx'
import CompleteStep from '../components/import/CompleteStep.jsx'

// Wide working screens get more room for tables/mapping grids; every other
// step is a narrower, focused decision screen. Purely a width choice — no
// behavior or step logic depends on this set.
const WIDE_STEPS = new Set(['mapping', 'preview', 'review', 'rejected'])

const STEP_TITLES = {
  upload: 'Upload a file',
  parsing: 'Reading your file',
  file_error: 'File could not be read',
  sheet: 'Choose a worksheet',
  headers: 'Confirm column headers',
  mapping: 'Map columns to Duewatch fields',
  dates: 'Confirm date formats',
  currency: 'Confirm default currency',
  preview: 'Preview',
  review: 'Rows needing review',
  rejected: 'Rejected rows',
  complete: 'Preview complete',
}

const INITIAL_STATE = {
  fileMeta: null,
  fileError: null,
  parsed: null,
  sheetIndex: 0,
  hasHeaderRow: null,
  sheetView: null,
  mapping: {},
  mappingOrigin: {},
  mappingBuiltFor: null,
  dateConvention: {},
  selectedCurrency: 'USD',
  defaultCurrencyConfirmed: false,
  normalizeResult: null,
}

export default function Import() {
  const [step, setStep] = useState('upload')
  const [history, setHistory] = useState(['upload'])
  const [s, setS] = useState(INITIAL_STATE)
  const [liveMessage, setLiveMessage] = useState('')
  const stepHeadingRef = useRef(null)

  // Move focus to the new step's heading on every transition so keyboard
  // and screen-reader users land somewhere meaningful instead of staying
  // wherever focus happened to be on the previous screen.
  useEffect(() => {
    stepHeadingRef.current?.focus()
  }, [step])

  function announcePreview(result) {
    setLiveMessage(
      `Preview ready. ${result.summary.total} rows: ${result.summary.ready} ready, ` +
        `${result.summary.ready_with_warnings} ready with warnings, ${result.summary.review_required} need review, ` +
        `${result.summary.rejected} rejected.`
    )
  }

  function patch(partial) {
    setS((cur) => ({ ...cur, ...partial }))
  }

  function goTo(next) {
    setHistory((h) => [...h, next])
    setStep(next)
  }

  function goBack() {
    setHistory((h) => {
      if (h.length <= 1) return h
      const nh = h.slice(0, -1)
      setStep(nh[nh.length - 1])
      return nh
    })
  }

  function resetAll() {
    setS(INITIAL_STATE)
    setHistory(['upload'])
    setStep('upload')
  }

  async function handleFileSelected(file) {
    patch({ ...INITIAL_STATE }) // a new file always supersedes any prior parsed/mapping state
    setStep('parsing') // ephemeral — not pushed onto history, so Back never lands here
    const result = await parseUpload(file)
    if (!result.ok) {
      patch({ fileError: result.error })
      setStep('file_error')
      return
    }
    patch({ parsed: result.parsed, fileMeta: { name: file.name } })
    setLiveMessage(`File read. ${result.parsed.sheets.length} sheet${result.parsed.sheets.length === 1 ? '' : 's'} found.`)
    goTo(result.parsed.sheets.length > 1 ? 'sheet' : 'headers')
  }

  function handleSelectSheet(index) {
    if (index === s.sheetIndex) return
    patch({ sheetIndex: index, hasHeaderRow: null })
  }

  function handleChooseHeaderRow(value) {
    patch({ hasHeaderRow: value })
  }

  function handleHeaderContinue() {
    const sheet = s.parsed.sheets[s.sheetIndex]
    const view = buildSheetView(sheet, s.hasHeaderRow)
    const sameContext =
      s.mappingBuiltFor && s.mappingBuiltFor.sheetIndex === s.sheetIndex && s.mappingBuiltFor.hasHeaderRow === s.hasHeaderRow

    if (sameContext) {
      patch({ sheetView: view })
    } else {
      const suggested = createInitialMapping(view.headers)
      patch({
        sheetView: view,
        mapping: suggested,
        mappingOrigin: Object.fromEntries(Object.keys(suggested).map((k) => [k, 'suggested'])),
        mappingBuiltFor: { sheetIndex: s.sheetIndex, hasHeaderRow: s.hasHeaderRow },
        dateConvention: {},
        selectedCurrency: 'USD',
        defaultCurrencyConfirmed: false,
        normalizeResult: null,
      })
    }
    goTo('mapping')
  }

  function handleMappingChange(colIndex, fieldKey) {
    const nextMapping = { ...s.mapping }
    if (fieldKey === IGNORE_KEY) delete nextMapping[colIndex]
    else nextMapping[colIndex] = fieldKey

    const nextDateConvention = invalidateDateDecisions(s.mapping, nextMapping, s.dateConvention)

    const nextOrigin = { ...s.mappingOrigin }
    if (fieldKey === IGNORE_KEY) delete nextOrigin[colIndex]
    else nextOrigin[colIndex] = 'chosen'

    patch({
      mapping: nextMapping,
      mappingOrigin: nextOrigin,
      dateConvention: nextDateConvention,
      normalizeResult: null, // stale — must be rebuilt against the new mapping
    })
  }

  const mappingValidation = useMemo(() => validateMapping(s.mapping), [s.mapping])

  function runNormalization(overrides = {}) {
    const result = normalizeParsedUpload({
      parsed: s.parsed,
      sheetIndex: s.sheetIndex,
      hasHeaderRow: s.hasHeaderRow,
      mapping: s.mapping,
      dateConvention: overrides.dateConvention ?? s.dateConvention,
      selectedDefaultCurrency: overrides.selectedCurrency ?? s.selectedCurrency,
      defaultCurrencyConfirmed: overrides.defaultCurrencyConfirmed ?? s.defaultCurrencyConfirmed,
    })
    patch({ normalizeResult: result })
    return result
  }

  function handleContinueFromMapping() {
    const result = runNormalization()
    if (needsDateDecisionStep(result.rows)) goTo('dates')
    else if (needsCurrencyStep(result.rows)) goTo('currency')
    else {
      announcePreview(result)
      goTo('preview')
    }
  }

  function handleConfirmDates(pendingConvention) {
    patch({ dateConvention: pendingConvention })
    const result = runNormalization({ dateConvention: pendingConvention })
    if (needsCurrencyStep(result.rows)) goTo('currency')
    else {
      announcePreview(result)
      goTo('preview')
    }
  }

  function handleConfirmCurrency(code) {
    patch({ selectedCurrency: code, defaultCurrencyConfirmed: true })
    const result = runNormalization({ selectedCurrency: code, defaultCurrencyConfirmed: true })
    announcePreview(result)
    goTo('preview')
  }

  const widthVariant = step === 'upload' ? 'import-shell--upload' : WIDE_STEPS.has(step) ? 'import-shell--wide' : 'import-shell--narrow'

  return (
    <div className={`brief import-shell ${widthVariant}`}>
      <div className="list-head">
        <div>
          <h1 className="brief-greeting">Invoices</h1>
          <h2 className="import-title">Import preview from CSV or Excel</h2>
        </div>
        <Link to="/invoices" className="import-cancel-link">
          <X width={16} height={16} /> Cancel
        </Link>
      </div>

      <div className="sr-only" aria-live="polite" role="status">
        {liveMessage}
      </div>

      <StepProgress
        step={step}
        showSheetPhase={(s.parsed?.sheets.length ?? 0) > 1}
        showDatesPhase={step === 'dates' || (s.normalizeResult && needsDateDecisionStep(s.normalizeResult.rows))}
        showCurrencyPhase={step === 'currency' || (s.normalizeResult && needsCurrencyStep(s.normalizeResult.rows))}
      />

      <h3 ref={stepHeadingRef} tabIndex={-1} className="import-step-heading">
        {STEP_TITLES[step]}
      </h3>

      {s.fileMeta && step !== 'upload' && step !== 'parsing' && step !== 'file_error' && (
        <p className="import-filename">
          {s.fileMeta.name}
          <button className="import-restart" onClick={resetAll}>
            Start over
          </button>
        </p>
      )}

      {step === 'upload' && (
        <div className="import-upload-intro">
          <p className="import-upload-headline">Bring your invoice export.</p>
          <p className="import-upload-body">
            Upload a CSV or Excel file from your bookkeeping software. DueWatch will organize the fields, flag
            anything uncertain, and show you a preview before anything proceeds.
          </p>
          <div className="import-upload-art">
            <img src={importHeroImg} alt="" aria-hidden="true" className="import-upload-hero-img" />
          </div>
          <div className="import-upload-control">
            <UploadStep onFile={handleFileSelected} />
          </div>
          <p className="import-upload-trust">Nothing is saved during preview.</p>
        </div>
      )}

      {step === 'parsing' && <ParsingStep />}

      {step === 'file_error' && <FileErrorStep error={s.fileError} onRetry={resetAll} />}

      {step === 'sheet' && (
        <SheetStep
          sheets={s.parsed.sheets}
          selectedIndex={s.sheetIndex}
          onSelect={handleSelectSheet}
          onContinue={() => goTo('headers')}
          onBack={goBack}
        />
      )}

      {step === 'headers' && (
        <HeaderStep
          sheet={s.parsed.sheets[s.sheetIndex]}
          hasHeaderRow={s.hasHeaderRow}
          onChoose={handleChooseHeaderRow}
          onContinue={handleHeaderContinue}
          onBack={goBack}
        />
      )}

      {step === 'mapping' && (
        <MappingStep
          headers={s.sheetView.headers}
          sampleRows={s.sheetView.sampleRows}
          mapping={s.mapping}
          mappingOrigin={s.mappingOrigin}
          validation={mappingValidation}
          onMappingChange={handleMappingChange}
          onContinue={handleContinueFromMapping}
          onBack={goBack}
        />
      )}

      {step === 'dates' && s.normalizeResult && (
        <DatesStep
          rows={s.normalizeResult.rows}
          headers={s.sheetView.headers}
          dateConvention={s.dateConvention}
          onConfirm={handleConfirmDates}
          onBack={goBack}
        />
      )}

      {step === 'currency' && s.normalizeResult && (
        <CurrencyStep
          rows={s.normalizeResult.rows}
          selectedCurrency={s.selectedCurrency}
          onSelect={(code) => patch({ selectedCurrency: code })}
          onConfirm={handleConfirmCurrency}
          onBack={goBack}
        />
      )}

      {step === 'preview' && s.normalizeResult && (
        <PreviewStep
          result={s.normalizeResult}
          headers={s.sheetView.headers}
          onBack={goBack}
          onFinish={() => goTo('complete')}
          onInspectReview={() => goTo('review')}
          onInspectRejected={() => goTo('rejected')}
        />
      )}

      {step === 'review' && s.normalizeResult && (
        <ReviewStep result={s.normalizeResult} onBack={goBack} onGoToDates={() => goTo('dates')} />
      )}

      {step === 'rejected' && s.normalizeResult && (
        <RejectedStep result={s.normalizeResult} onBack={goBack} />
      )}

      {step === 'complete' && s.normalizeResult && (
        <CompleteStep summary={s.normalizeResult.summary} onStartOver={resetAll} />
      )}
    </div>
  )
}
