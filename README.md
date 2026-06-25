# 🎮 Crash

A faithful web recreation of the classic 1996 DOS game **CRASH** (Tron light-cycles) by Digital Nightmares.

## About

This project is a modern browser-based recreation of the iconic light-cycles gameplay from the original CRASH DOS game. Control your vehicle, avoid collisions, and outlast your opponents in this timeless arcade-style game.

## Features

- 🕹️ Classic light-cycles gameplay
- 🤖 AI opponents with intelligent steering
- ⚡ High-performance web implementation using WebWorkers
- 📱 Responsive design for modern browsers
- 🎯 Configurable maps and game parameters
- 🔄 Training and optimization tools included

## Getting Started

### Prerequisites
- Node.js (v22+)
- npm (v10+)

### Installation

```bash
# Clone the repository
git clone https://github.com/tamkrisz/crash.git
cd crash

# Install dependencies
npm install
```

### Development

```bash
# Start development server
npm run dev
```

The game will be available at `http://localhost:5173`

### Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

### Deployment

Deploy to Cloudflare Workers:

```bash
npm run deploy
```

## Project Structure

```
├── src/
│   ├── main.ts           # Entry point
│   ├── game.ts           # Game logic
│   ├── player.ts         # Player mechanics
│   ├── ai/               # AI system
│   ├── parallel/         # Web Worker optimization
│   └── maps.ts           # Level definitions
├── train/                # Training utilities
├── vite.config.ts        # Vite configuration
└── package.json
```

## Technologies

- **Frontend**: TypeScript, Vite
- **Build**: Vite 6, TypeScript Compiler
- **Deploy**: Cloudflare Workers
- **Performance**: Web Workers for parallel processing

## License

Inspired by the original CRASH game by Digital Nightmares (1996)

---

**Status**: ✅ Production Ready | 🚀 Deployed on Cloudflare Workers
