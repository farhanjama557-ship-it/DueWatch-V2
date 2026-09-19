import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from '../src/App.jsx'
import '../src/index.css'
import '../src/styles/presence.css'
import '../src/styles/presence-reduced-motion.css'
import '../src/styles/product-v1.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
)
