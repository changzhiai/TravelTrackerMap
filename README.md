# Travel Tracker Map

An interactive world map application for tracking visited countries. Built with React, TypeScript, Vite, and Tailwind CSS.

## Features

- 🌍 Interactive world map with zoom and pan
- ✅ Click countries to mark them as visited
- 📊 Track your travel statistics
- 🔍 Search and filter countries
- 💾 Data persistence with localStorage (or Firebase)
- 📱 Responsive design

## Getting Started

### Prerequisites

- Node.js 18+ and npm

### Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd travel-tracker-map
```

2. Install dependencies:
```bash
npm install
```

3. Start the development server:
```bash
npm run dev
```

4. Open your browser to `http://localhost:5173`

## Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Deployment

This project is configured for GitHub Pages deployment. Simply push to the `main` branch and GitHub Actions will automatically build and deploy the site.

### Manual Deployment

1. Build the project:
```bash
npm run build
```

2. The `dist` folder contains the production build.

## Configuration

### Firebase (Optional)

To use Firebase for data persistence, add your Firebase configuration via global variables in `index.html`:

```html
<script>
  window.__firebase_config = '{"apiKey":"...","authDomain":"...",...}';
  window.__app_id = 'your-app-id';
</script>
```

Without Firebase, the app uses localStorage for data persistence.

## Technologies Used

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Firebase (optional)
- Lucide React (icons)

## License

MIT
