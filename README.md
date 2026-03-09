# 🏏 Hand Cricket Multiplayer

A modern, real-time multiplayer Hand Cricket game built with Node.js, Socket.IO, and SQLite. Play against friends in private rooms or challenge a learning AI bot!

## ✨ Features

- **Real-time Multiplayer**: Powered by Socket.IO for lag-free number picking.
- **Game Modes**: 
  - **1v1 Duel**: Challenge a friend in a private room.
  - **Tournament**: Organize a bracket-style competition (Supports CPU bots).
  - **Play vs CPU**: Quick match against an adaptive AI.
- **Learning AI**: The CPU learns your patterns (frequency and pick transitions) and adapts its strategy in real-time.
- **Detailed Match History**: Ball-by-ball logs and statistics for every match you play.
- **Premium UI**: Sleek dark-mode aesthetic with smooth transitions and micro-animations.

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v16 or higher)
- npm (comes with Node.js)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd CricketGame
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the server:**
   ```bash
   npm start
   ```

4. **Play the game:**
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism), JavaScript (ES6+)
- **Backend**: Node.js, Express
- **Real-time**: Socket.IO
- **Database**: SQLite3 (better-sqlite3)
- **Authentication**: JWT & BcryptJS

## 🧠 How the AI Works

The game features a **Behavioral Learning AI** that tracks:
1. **Frequency Analysis**: Keeps track of which numbers you pick most often.
2. **Transition Matrix**: Predicts your next move based on your previous pick.

The AI will intentionally avoid your common bowling picks while batting and try to "guess" your batsman picks while bowling!

## 📄 License

This project is licensed under the ISC License.
