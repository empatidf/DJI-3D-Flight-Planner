import { useEffect } from 'react'
import { CesiumMap } from './components/CesiumMap'
import { LeftPanel } from './components/LeftPanel'
import { FlightPlanner } from './components/FlightPlanner'
import { DisclaimerModal } from './components/DisclaimerModal'
import { startMissionPersistence } from './lib/project-folder/folder-sync'
import './App.css'

function App() {
  // Loads missions from browser storage and reopens the project folder.
  useEffect(() => {
    startMissionPersistence()
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
