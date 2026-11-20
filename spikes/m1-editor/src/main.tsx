import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { runFuzz, runSizeTest } from './fuzz'
import './style.css'

// test hooks (Playwright runs the fuzzer inside the page, where a real DOM exists)
Object.assign(window, { __fuzz: runFuzz, __sizeTest: runSizeTest })

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
