import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
