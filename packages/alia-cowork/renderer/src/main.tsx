import { createRoot } from "react-dom/client"

// CSS is built separately by Gulp
// import "./index.css"
import App from "./App.tsx"

createRoot(document.getElementById("root")!).render(<App />)
