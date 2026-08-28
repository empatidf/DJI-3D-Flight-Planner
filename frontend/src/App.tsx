import { CesiumMap } from './components/CesiumMap'
import { LeftPanel } from './components/LeftPanel'
import { FlightPlanner } from './components/FlightPlanner'
import { DisclaimerModal } from './components/DisclaimerModal'
import './App.css'

function App() {
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
