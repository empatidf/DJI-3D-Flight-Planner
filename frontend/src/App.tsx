import { CesiumMap } from './components/CesiumMap'
import { LayerManager } from './components/LayerManager'
import { MissionManager } from './components/MissionManager'
import { FlightPlanner } from './components/FlightPlanner'
import { DisclaimerModal } from './components/DisclaimerModal'
import './App.css'

function App() {
  return (
    <div className="app">
      <DisclaimerModal />
      <CesiumMap />
      <div className="left-sidebar">
        <LayerManager />
        <MissionManager />
      </div>
      <FlightPlanner />
    </div>
  )
}

export default App
