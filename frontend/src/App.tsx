import { useEffect } from 'react'
import { CesiumMap } from './components/CesiumMap'
import { LeftPanel } from './components/LeftPanel'
import { FlightPlanner } from './components/FlightPlanner'
import { DisclaimerModal } from './components/DisclaimerModal'
import { startMissionPersistence } from './lib/project-folder/folder-sync'
import { startLocalFileAutoOpen } from './lib/local-tiff/auto-open'
import './App.css'

function App() {
  // Loads missions from browser storage and reopens the project folder.
  useEffect(() => {
    startMissionPersistence()
    // Local orthophoto / DSM files are re-opened from their stored handles,
    // whether or not the Map section of the panel is open.
    startLocalFileAutoOpen()
  }, [])

  return (
    <div className="app">
      <DisclaimerModal />
      <CesiumMap />
      <LeftPanel />
      <FlightPlanner />
    </div>
  )
}

export default App
