import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Globe, Map as MapIcon, CheckCircle2, Search, Loader2, Trophy, Percent, Navigation, Download, Tag, Plus, Minus, RotateCcw } from 'lucide-react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  signInAnonymously, 
  signInWithCustomToken, 
  onAuthStateChanged
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import { 
  getFirestore, 
  collection, 
  doc, 
  setDoc, 
  deleteDoc, 
  onSnapshot, 
  query 
} from 'firebase/firestore';

// --- Firebase Configuration & Initialization ---
let app: any = null;
let auth: any = null;
let db: any = null;
let firebaseAvailable = false;

// Try to initialize Firebase if config is provided via global variable
try {
  const firebaseConfigStr = typeof (window as any).__firebase_config !== 'undefined' ? (window as any).__firebase_config : null;
  if (firebaseConfigStr) {
    const firebaseConfig = JSON.parse(firebaseConfigStr);
    // Check if config has required fields
    if (firebaseConfig.apiKey && firebaseConfig.projectId) {
      app = initializeApp(firebaseConfig);
      auth = getAuth(app);
      db = getFirestore(app);
      firebaseAvailable = true;
    }
  }
} catch (error) {
  console.warn('Firebase not configured, using localStorage fallback');
}

const appId = typeof (window as any).__app_id !== 'undefined' ? (window as any).__app_id : 'default-app-id';
const globalAuthToken = typeof (window as any).__initial_auth_token !== 'undefined' ? (window as any).__initial_auth_token : undefined;


// --- Types ---
type CountryProperties = {
  name: string;
  id: string; // Ensure this is always present
};

type GeoJSONFeature = {
  type: 'Feature';
  id?: string; // Top level ID sometimes exists
  properties: CountryProperties;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: any[];
  };
};

type GeoJSON = {
  type: 'FeatureCollection';
  features: GeoJSONFeature[];
};

type VisitedCountry = {
  id: string; // ISO 3 or Name
  name: string;
  visitedAt: number;
};

// --- Map Projection Helpers (Equirectangular) ---
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 500;

const project = (lon: number, lat: number) => {
  const x = (lon + 180) * (MAP_WIDTH / 360);
  const y = ((-lat) + 90) * (MAP_HEIGHT / 180);
  return { x, y };
};

const createPath = (feature: GeoJSONFeature): string => {
  const { geometry } = feature;
  if (!geometry || !geometry.coordinates) return ''; // Safety check

  let path = '';

  const drawPolygon = (coords: any[]) => {
    let d = '';
    coords.forEach((point, i) => {
      // Basic validation for point
      if (!Array.isArray(point) || point.length < 2) return;
      
      const [lon, lat] = point;
      const { x, y } = project(lon, lat);
      if (i === 0) d += `M${x},${y}`;
      else d += `L${x},${y}`;
    });
    d += 'Z ';
    return d;
  };

  if (geometry.type === 'Polygon') {
    geometry.coordinates.forEach((ring: any[]) => {
      path += drawPolygon(ring);
    });
  } else if (geometry.type === 'MultiPolygon') {
    geometry.coordinates.forEach((polygon: any[][]) => {
      polygon.forEach((ring: any[]) => {
        path += drawPolygon(ring);
      });
    });
  }
  return path;
};

// Calculate centroid for label positioning
const getLabelPosition = (feature: GeoJSONFeature) => {
  let bestRing: any[] = [];
  
  // Find largest ring (main landmass) to place label
  if (feature.geometry.type === 'Polygon') {
    if (feature.geometry.coordinates.length > 0) {
       bestRing = feature.geometry.coordinates[0];
    }
  } else if (feature.geometry.type === 'MultiPolygon') {
    let maxLen = 0;
    feature.geometry.coordinates.forEach(poly => {
        if (poly[0].length > maxLen) {
            maxLen = poly[0].length;
            bestRing = poly[0];
        }
    });
  }

  if (!bestRing || bestRing.length === 0) return null;

  // Calculate bounding box of the ring
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  
  bestRing.forEach(p => {
     const {x, y} = project(p[0], p[1]);
     if (x < minX) minX = x;
     if (x > maxX) maxX = x;
     if (y < minY) minY = y;
     if (y > maxY) maxY = y;
  });

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
};

// --- Main Component ---
export default function TravelTracker() {
  const [user, setUser] = useState<User | null>(null);
  const [geoData, setGeoData] = useState<GeoJSON | null>(null);
  const [loadingMap, setLoadingMap] = useState(true);
  const [visited, setVisited] = useState<Record<string, VisitedCountry>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const [activeTab, setActiveTab] = useState<'map' | 'list'>('map');
  const [hoveredCountry, setHoveredCountry] = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(false);
  const mapRef = useRef<SVGSVGElement>(null);

  // Zoom & Pan State
  const [transform, setTransform] = useState({ k: 1, x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const isDragRef = useRef(false); // To distinguish click vs drag
  const pinchDistanceRef = useRef<number | null>(null);
  const pinchStartScaleRef = useRef(1);

  const getTouchDistance = (touches: React.TouchList) => {
    const [a, b] = [touches[0], touches[1]];
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchMidpoint = (touches: React.TouchList) => {
    const [a, b] = [touches[0], touches[1]];
    return {
      x: (a.clientX + b.clientX) / 2,
      y: (a.clientY + b.clientY) / 2
    };
  };

  // 1. Auth & Data Init
  useEffect(() => {
    if (!firebaseAvailable) {
      // Use demo mode - set a mock user and load from localStorage
      setUser({ uid: 'demo-user' } as User);
      
      // Load visited countries from localStorage
      try {
        const stored = localStorage.getItem('travel-tracker-visited');
        if (stored) {
          setVisited(JSON.parse(stored));
        }
      } catch (error) {
        console.error('Failed to load from localStorage:', error);
      }
      return;
    }

    const initAuth = async () => {
      try {
        // Use custom token if available (from Canvas environment), otherwise sign in anonymously
        if (globalAuthToken) {
          await signInWithCustomToken(auth, globalAuthToken);
        } else {
          await signInAnonymously(auth);
        }
      } catch (error) {
        console.error('Auth initialization failed:', error);
        // Fallback to demo mode
        setUser({ uid: 'demo-user' } as User);
      }
    };
    initAuth();

    const unsubscribeAuth = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
    });
    return () => unsubscribeAuth();
  }, []);

  // 2. Fetch GeoJSON and Sanitize
  useEffect(() => {
    const fetchMapData = async () => {
      try {
        // Using a public GeoJSON source for world map data
        const res = await fetch('https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson');
        const data = await res.json();
        
        // Critical: Sanitize data to ensure every feature has a unique ID and name
        const sanitizedFeatures = data.features.map((f: any, index: number) => {
          const rawId = f.id || f.properties?.id || f.properties?.iso_a3 || f.properties?.name || `unknown-${index}`;
          let name = f.properties?.name || 'Unknown Country';

          // Explicitly rename Taiwan for consistency
          if (name === 'Taiwan') {
            name = 'Taiwan (China)';
          }
          
          return {
            ...f,
            properties: {
              ...f.properties,
              id: String(rawId),
              name: String(name)
            }
          };
        }).filter((f: any) => f.properties.id && f.properties.name && f.geometry);

        setGeoData({ ...data, features: sanitizedFeatures });
      } catch (error) {
        console.error("Failed to load map data", error);
      } finally {
        setLoadingMap(false);
      }
    };
    fetchMapData();
  }, []);

  // 3. Firestore Listeners
  useEffect(() => {
    if (!user) return;

    if (!firebaseAvailable) {
      // Already loaded from localStorage in auth effect
      return;
    }

    // Data path: /artifacts/{appId}/users/{userId}/visited
    const visitedRef = collection(db, 'artifacts', appId, 'users', user.uid, 'visited');
    const q = query(visitedRef);

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const newVisited: Record<string, VisitedCountry> = {};
      snapshot.forEach((doc) => {
        // Ensure data retrieval matches VisitedCountry type
        newVisited[doc.id] = doc.data() as VisitedCountry;
      });
      setVisited(newVisited);
    }, (error) => {
      console.error("Firestore error:", error);
    });

    return () => unsubscribe();
  }, [user]);

  // --- Handlers ---

  const handleCountryClick = (feature: GeoJSONFeature) => {
    // Prevent click action if the user was dragging the map
    if (isDragRef.current) return;
    
    toggleCountry(feature);
  };

  const toggleCountry = async (feature: GeoJSONFeature) => {
    if (!user) return;
    const { id, name } = feature.properties;
    
    if (!id) return; 

    const isVisited = !!visited[id];

    if (!firebaseAvailable) {
      // Use localStorage
      const newVisited = { ...visited };
      if (isVisited) {
        delete newVisited[id];
      } else {
        newVisited[id] = {
          id,
          name: name || id,
          visitedAt: Date.now()
        };
      }
      setVisited(newVisited);
      try {
        localStorage.setItem('travel-tracker-visited', JSON.stringify(newVisited));
      } catch (e) {
        console.error("Error saving to localStorage:", e);
      }
      return;
    }

    // Document reference for the specific country
    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'visited', id);

    try {
      if (isVisited) {
        // Mark as unvisited (delete document)
        await deleteDoc(docRef);
      } else {
        // Mark as visited (create/set document)
        await setDoc(docRef, {
          id,
          name: name || id,
          visitedAt: Date.now()
        });
      }
    } catch (e) {
      console.error("Error toggling country:", e);
    }
  };

  const toggleById = async (id: string, name: string) => {
    // This is used by the list component, performs the same logic as toggleCountry
    if (!user || !id) return;
    
    const isVisited = !!visited[id];

    if (!firebaseAvailable) {
      // Use localStorage
      const newVisited = { ...visited };
      if (isVisited) {
        delete newVisited[id];
      } else {
        newVisited[id] = {
          id,
          name,
          visitedAt: Date.now()
        };
      }
      setVisited(newVisited);
      try {
        localStorage.setItem('travel-tracker-visited', JSON.stringify(newVisited));
      } catch (e) {
        console.error("Error saving to localStorage:", e);
      }
      return;
    }

    const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'visited', id);

    try {
      if (isVisited) {
        await deleteDoc(docRef);
      } else {
        await setDoc(docRef, {
          id,
          name,
          visitedAt: Date.now()
        });
      }
    } catch (e) {
      console.error("Error toggling country by ID:", e);
    }
  };

  const saveMapImage = () => {
    if (!mapRef.current) return;

    // Function to convert SVG to PNG for download
    const svgData = new XMLSerializer().serializeToString(mapRef.current);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const img = new Image();
    
    const svgBlob = new Blob([svgData], {type: "image/svg+xml;charset=utf-8"});
    const url = URL.createObjectURL(svgBlob);
    
    img.onload = () => {
      const verticalPadding = 40; // add visual breathing room above/below map
      canvas.width = MAP_WIDTH;
      canvas.height = MAP_HEIGHT + verticalPadding * 2;
      
      if (ctx) {
        // Draw white background before drawing SVG content
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.drawImage(img, 0, verticalPadding);
        
        const pngUrl = canvas.toDataURL("image/png");
        const downloadLink = document.createElement("a");
        downloadLink.href = pngUrl;
        downloadLink.download = `travel-map-${new Date().toISOString().split('T')[0]}.png`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
      }
      URL.revokeObjectURL(url);
    };
    
    img.src = url;
  };

  // --- Zoom & Pan Logic ---

  const handleZoom = (factor: number) => {
    setTransform(prev => {
      // Clamp scale factor
      const newK = Math.max(1, Math.min(8, prev.k * factor));
      // Simple zoom-towards-center logic for button controls
      const cx = MAP_WIDTH / 2;
      const cy = MAP_HEIGHT / 2;
      const newX = cx - (cx - prev.x) * (newK / prev.k);
      const newY = cy - (cy - prev.y) * (newK / prev.k);
      return { k: newK, x: newX, y: newY };
    });
  };

  const handleResetZoom = () => {
    setTransform({ k: 1, x: 0, y: 0 });
  };

  const handleWheel = (e: React.WheelEvent) => {
    // Advanced mouse-centric zoom logic
    if (!mapRef.current) return;
    
    // Determine scale direction
    const scaleFactor = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(prev => {
        const newK = Math.max(1, Math.min(8, prev.k * scaleFactor));
        
        const rect = mapRef.current!.getBoundingClientRect();
        // Mouse position relative to the SVG element in pixels
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Convert pixel mouse position to SVG viewbox coordinates
        const svgMx = mx * (MAP_WIDTH / rect.width);
        const svgMy = my * (MAP_HEIGHT / rect.height);

        // Calculate new offset to keep the point under the mouse stable
        const newX = svgMx - (svgMx - prev.x) * (newK / prev.k);
        const newY = svgMy - (svgMy - prev.y) * (newK / prev.k);

        return { k: newK, x: newX, y: newY };
    });
  };

  const handleMouseDown = (e: React.MouseEvent | React.TouchEvent) => {
    setIsDragging(true);
    isDragRef.current = false;
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;
    lastMousePos.current = { x: clientX, y: clientY };
  };

  const handleMouseMove = (e: React.MouseEvent | React.TouchEvent) => {
    if (!isDragging) return;
    
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
    const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

    const dx = clientX - lastMousePos.current.x;
    const dy = clientY - lastMousePos.current.y;
    
    // Set drag flag if movement exceeds a small threshold (2px)
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        isDragRef.current = true;
    }

    let scaleRatio = 1;
    if (mapRef.current) {
        const rect = mapRef.current.getBoundingClientRect();
        // Calculate ratio to translate screen pixels to SVG viewbox units
        scaleRatio = MAP_WIDTH / rect.width;
    }

    setTransform(prev => ({
      ...prev,
      x: prev.x + (dx * scaleRatio),
      y: prev.y + (dy * scaleRatio)
    }));
    
    lastMousePos.current = { x: clientX, y: clientY };
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchDistanceRef.current = getTouchDistance(e.touches);
      pinchStartScaleRef.current = transform.k;
      isDragRef.current = false;
      setIsDragging(false);
    } else {
      handleMouseDown(e);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchDistanceRef.current && mapRef.current) {
      e.preventDefault();
      const currentDistance = getTouchDistance(e.touches);
      const scaleFactor = currentDistance / pinchDistanceRef.current;
      const desiredScale = Math.max(1, Math.min(8, pinchStartScaleRef.current * scaleFactor));

      const rect = mapRef.current.getBoundingClientRect();
      const midpoint = getTouchMidpoint(e.touches);
      const mx = midpoint.x - rect.left;
      const my = midpoint.y - rect.top;
      const svgMx = mx * (MAP_WIDTH / rect.width);
      const svgMy = my * (MAP_HEIGHT / rect.height);

      setTransform(prev => {
        const newX = svgMx - (svgMx - prev.x) * (desiredScale / prev.k);
        const newY = svgMy - (svgMy - prev.y) * (desiredScale / prev.k);
        return { k: desiredScale, x: newX, y: newY };
      });
    } else {
      handleMouseMove(e);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (e.touches.length < 2) {
      pinchDistanceRef.current = null;
      pinchStartScaleRef.current = transform.k;
    }
    handleMouseUp();
  };

  const handleMouseUp = () => {
    setIsDragging(false);
    // isDragRef.current will be reset on the *next* mousedown event
  };

  // --- Derived State ---
  const visitedCount = Object.keys(visited).length;
  const totalCountries = geoData?.features.length || 0;
  const percentage = totalCountries > 0 ? ((visitedCount / totalCountries) * 100).toFixed(1) : '0';

  const filteredCountries = useMemo(() => {
    if (!geoData) return [];
    // Filter and sort the country list for the sidebar
    return geoData.features
      .filter(f => {
        const name = f.properties.name || '';
        return name.toLowerCase().includes(searchTerm.toLowerCase());
      })
      .sort((a, b) => (a.properties.name || '').localeCompare(b.properties.name || ''));
  }, [geoData, searchTerm]);

  // --- Render Helpers ---

  if (!user || loadingMap) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-400">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 animate-spin text-emerald-500" />
          <p>Preparing your map and connecting to data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col font-sans text-slate-900">
      
      {/* Header */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20 shadow-sm">
        <div className="max-w-6xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="flex items-center gap-3">
              <div className="bg-emerald-100 p-2 rounded-lg">
                <Globe className="w-6 h-6 text-emerald-600" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight text-slate-800">Travel Tracker</h1>
                <p className="text-xs text-slate-500">Track your global adventures</p>
              </div>
            </div>

            <div className="flex gap-4">
              <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full">
                <Trophy className="w-4 h-4 text-amber-500" />
                <span className="font-semibold text-slate-700">{visitedCount}</span>
                <span className="text-slate-400 text-sm">Countries</span>
              </div>
              <div className="flex items-center gap-2 bg-slate-100 px-3 py-1.5 rounded-full">
                <Percent className="w-4 h-4 text-blue-500" />
                <span className="font-semibold text-slate-700">{percentage}%</span>
                <span className="text-slate-400 text-sm">World</span>
              </div>
            </div>
          </div>

          {/* Tab Navigation (Mobile Friendly) */}
          <div className="flex gap-2 mt-4 md:hidden">
            <button
              onClick={() => setActiveTab('map')}
              className={`flex-1 py-2 text-sm font-medium rounded-md flex items-center justify-center gap-2 ${
                activeTab === 'map' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              <MapIcon className="w-4 h-4" /> Map
            </button>
            <button
              onClick={() => setActiveTab('list')}
              className={`flex-1 py-2 text-sm font-medium rounded-md flex items-center justify-center gap-2 ${
                activeTab === 'list' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600'
              }`}
            >
              <Navigation className="w-4 h-4" /> List
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl mx-auto w-full p-4 flex flex-col md:flex-row gap-6">
        
        {/* Map Section */}
        <div className={`flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden ${activeTab === 'map' ? 'flex' : 'hidden md:flex'}`}>
          <div className="p-4 border-b border-slate-100 flex justify-between items-center flex-wrap gap-2">
            <h2 className="font-semibold text-slate-700 flex items-center gap-2">
              <MapIcon className="w-4 h-4 text-slate-400" /> World Map
            </h2>
            <div className="flex items-center gap-2 flex-wrap">
               {/* Zoom Controls Overlay Buttons */}
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-lg">
                 <button onClick={() => handleZoom(1.2)} className="p-1 hover:bg-white rounded-md shadow-sm transition-all" title="Zoom In">
                    <Plus className="w-4 h-4 text-slate-600" />
                 </button>
                 <button onClick={() => handleZoom(0.8)} className="p-1 hover:bg-white rounded-md shadow-sm transition-all" title="Zoom Out">
                    <Minus className="w-4 h-4 text-slate-600" />
                 </button>
                 <button onClick={handleResetZoom} className="p-1 hover:bg-white rounded-md shadow-sm transition-all" title="Reset View">
                    <RotateCcw className="w-4 h-4 text-slate-600" />
                 </button>
              </div>

              <div className="w-px h-4 bg-slate-200 mx-1"></div>

              <button 
                onClick={() => setShowLabels(!showLabels)}
                className={`text-xs flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors font-medium ${
                  showLabels ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 hover:bg-slate-200 text-slate-600'
                }`}
                title="Toggle Country Names"
              >
                <Tag className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{showLabels ? 'Hide Labels' : 'Labels'}</span>
              </button>
              <button 
                onClick={saveMapImage}
                className="text-xs flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 px-3 py-1.5 rounded-lg transition-colors font-medium"
                title="Save as PNG"
              >
                <Download className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Save</span>
              </button>
            </div>
          </div>
          
          <div className="relative bg-slate-100 flex-1 min-h-[300px] md:min-h-[500px] w-full overflow-hidden flex items-center justify-center">
            {/* SVG Map Container */}
            <svg 
              ref={mapRef}
              viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`} 
              className={`w-full h-full max-h-[80vh] ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
              style={{ filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.05))', touchAction: 'none' }}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <style>
                {/* Inline CSS for map text for SVG rendering compatibility */}
                {`
                  .map-text { font-family: sans-serif; font-size: 8px; pointer-events: none; text-shadow: 0 1px 2px rgba(0,0,0,0.3); font-weight: 500; }
                `}
              </style>
              {/* Ocean Background */}
              <rect x={-5000} y={-5000} width={10000} height={10000} fill="#eff6ff" />
              
              <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.k})`}>
                
                {/* Countries Paths */}
                {geoData?.features.map((feature) => {
                  const id = feature.properties.id; 
                  const name = feature.properties.name;
                  const isVisited = !!visited[id];
                  const isHovered = hoveredCountry === id;

                  return (
                    <path
                      key={id}
                      d={createPath(feature)}
                      fill={isVisited ? '#10b981' : (isHovered ? '#cbd5e1' : '#e2e8f0')}
                      stroke="white"
                      strokeWidth={0.5 / transform.k} // Dynamic stroke width to look constant on zoom
                      className="transition-colors duration-200 ease-in-out hover:opacity-90"
                      onMouseEnter={() => setHoveredCountry(id)}
                      onMouseLeave={() => setHoveredCountry(null)}
                      onClick={() => handleCountryClick(feature)}
                    >
                      <title>{name} {isVisited ? '(Visited)' : ''}</title>
                    </path>
                  );
                })}

                {/* Labels Layer (Country Names) */}
                {showLabels && geoData?.features.map((feature) => {
                  const id = feature.properties.id;
                  const isVisited = !!visited[id];
                  
                  // Only show labels for visited countries
                  if (!isVisited) return null;

                  const pos = getLabelPosition(feature);
                  if (!pos) return null;

                  return (
                    <text
                      key={`label-${id}`}
                      x={pos.x}
                      y={pos.y}
                      textAnchor="middle"
                      fill="white"
                      className="map-text"
                      fontSize={8 / transform.k} // Scale font size to look constant on zoom
                    >
                      {feature.properties.name}
                    </text>
                  );
                })}
              </g>
            </svg>
            
            {/* Hover Tooltip Overlay */}
            {hoveredCountry && !showLabels && !isDragging && (
              <div className="absolute bottom-4 left-4 bg-slate-900/90 text-white px-3 py-1.5 rounded-lg text-sm font-medium shadow-xl pointer-events-none backdrop-blur-sm z-10">
                {geoData?.features.find(f => f.properties.id === hoveredCountry)?.properties.name}
              </div>
            )}
            
            {/* Zoom Hint */}
            <div className="absolute bottom-2 right-2 text-[10px] text-slate-400 pointer-events-none">
                Scroll to zoom • Drag to pan
            </div>
          </div>
        </div>

        {/* List Section */}
        <div className={`w-full md:w-80 flex flex-col bg-white rounded-2xl shadow-sm border border-slate-200 ${activeTab === 'list' ? 'flex' : 'hidden md:flex'}`}>
          <div className="p-4 border-b border-slate-100 space-y-3">
            <h2 className="font-semibold text-slate-700 flex items-center gap-2">
              <Navigation className="w-4 h-4 text-slate-400" /> Countries
            </h2>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input 
                type="text" 
                placeholder="Search country..."
                className="w-full pl-9 pr-4 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto max-h-[calc(100vh-250px)] p-2 space-y-1">
            {filteredCountries.length === 0 ? (
              <div className="text-center py-8 text-slate-400 text-sm">
                No countries found
              </div>
            ) : (
              filteredCountries.map((feature) => {
                const id = feature.properties.id; 
                const name = feature.properties.name;
                const isVisited = !!visited[id];

                return (
                  <button
                    key={id} 
                    onClick={() => toggleById(id, name)}
                    className={`w-full flex items-center justify-between p-3 rounded-xl text-sm transition-all duration-200 group ${
                      isVisited 
                        ? 'bg-emerald-50 text-emerald-900 hover:bg-emerald-100' 
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <span className="truncate font-medium">{name}</span>
                    {isVisited ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-500 flex-shrink-0" />
                    ) : (
                      <div className="w-5 h-5 rounded-full border-2 border-slate-200 group-hover:border-slate-300 transition-colors" />
                    )}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </main>
    </div>
  );
}