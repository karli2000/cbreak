import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { bindApi } from './api.ts'
import { createSiteClient } from './supabase.ts'
import './styles.css'

const client = createSiteClient()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App client={client} api={bindApi(client)} />
  </StrictMode>,
)
