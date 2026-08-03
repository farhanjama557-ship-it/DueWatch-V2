import { useRef, useState } from 'react'
import { Upload } from 'lucide-react'

export default function UploadStep({ onFile }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files) {
    const file = files?.[0]
    if (file) onFile(file)
  }

  function openPicker() {
    inputRef.current?.click()
  }

  return (
    <div>
      <div
        className={dragOver ? 'import-dropzone drag-over' : 'import-dropzone'}
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          handleFiles(e.dataTransfer.files)
        }}
        onClick={openPicker}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openPicker()
          }
        }}
        role="button"
        tabIndex={0}
        aria-label="Upload a CSV or Excel file"
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx"
          hidden
          onChange={(e) => handleFiles(e.target.files)}
        />
        <Upload className="import-dropzone-icon" aria-hidden="true" />
        <p className="import-dropzone-title">Drag a file here, or click to browse</p>
        <p className="import-dropzone-sub">Accepts .csv and .xlsx — up to 5 MiB, up to 10,000 rows</p>
        <p className="import-dropzone-sub">Nothing is saved to your account yet. This is a preview only.</p>
      </div>
    </div>
  )
}
