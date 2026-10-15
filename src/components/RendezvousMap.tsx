import React, { useState, useEffect, useRef } from 'react';
import { Trip, Traveler } from '../types/travel';
import L from 'leaflet';
import { 
  Navigation, Battery, BatteryWarning, MapPin, 
  Clock, Bell, Check, Edit2, Send, AlertTriangle, X, 
  Bus, RefreshCw, Key, Info, ExternalLink, ShieldAlert, Layers
} from 'lucide-react';

interface RendezvousMapProps {
  trip: Trip;
  activeTraveler: Traveler;
  onUpdateTrip: (updated: Trip) => void;
}

interface GeocodedAddress {
  building?: string;
  block?: string;
  road?: string;
  postalCode?: string;
  raw?: any;
}

interface BusArrivalService {
  serviceNo: string;
  operator: string;
  nextBus: {
    estimatedArrivalMins: number;
    load: string;
    feature: string;
    type: string;
  };
  subsequentBus?: {
    estimatedArrivalMins: number;
    load: string;
  };
}

// Singapore coordinate defaults
const LAU_PA_SAT_COORDS: [number, number] = [1.2806, 103.8504];
const ONEMAP_DEMO_COORDS: [number, number] = [1.2979, 103.8489]; // Fort Canning / Dhoby Ghaut

// Member locations in Singapore CBD / Chinatown
const MEMBER_COORDINATES: Record<string, [number, number]> = {
  'mem-1': [1.2825, 103.8440], // Alex: Chinatown Pagoda St
  'mem-2': [1.2806, 103.8504], // Priya: Lau Pa Sat table 18
  'mem-3': [1.2792, 103.8485], // Wei Ming: Telok Ayer MRT Exit A
  'mem-4': [1.2802, 103.8475], // Sarah: Amoy St Shophouses
  'mem-5': [1.2828, 103.8495], // Ryan: Cross St Junction
};

export const RendezvousMap: React.FC<RendezvousMapProps> = ({
  trip,
  activeTraveler,
  onUpdateTrip,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

  const [isEditingBeacon, setIsEditingBeacon] = useState(false);
  const [beaconName, setBeaconName] = useState(trip.meetupPoint.name);
  const [beaconTime, setBeaconTime] = useState(trip.meetupPoint.time);
  const [beaconNotes, setBeaconNotes] = useState(trip.meetupPoint.notes);

  const [quickStatus, setQuickStatus] = useState('');
  const [announcementBanner, setAnnouncementBanner] = useState<string | null>(null);

  // OneMap & Reverse Geocode State
  const [beaconCoords, setBeaconCoords] = useState<[number, number]>(LAU_PA_SAT_COORDS);
  const [selectedCoords, setSelectedCoords] = useState<[number, number]>(LAU_PA_SAT_COORDS);
  const [geocodedInfo, setGeocodedInfo] = useState<GeocodedAddress | null>(null);
  const [isGeocodingLoading, setIsGeocodingLoading] = useState(false);
  const [geocodeRawResponse, setGeocodeRawResponse] = useState<any | null>(null);
  const [showJsonInspector, setShowJsonInspector] = useState(false);

  // Bus Arrival State
  const [selectedBusStop, setSelectedBusStop] = useState('03079');
  const [busArrivalData, setBusArrivalData] = useState<{
    busStopName: string;
    roadName: string;
    services: BusArrivalService[];
    configured: boolean;
    requiresKeyNote?: string | null;
  } | null>(null);
  const [isBusLoading, setIsBusLoading] = useState(false);

  // OneMap Token / API Health
  const [onemapHealth, setOnemapHealth] = useState<{
    configured: boolean;
    status: string;
    message?: string;
  } | null>(null);

  const [activeTileLayer, setActiveTileLayer] = useState<'onemap' | 'night' | 'carto'>('onemap');

  // Check OneMap serverless health on mount
  useEffect(() => {
    checkHealth();
    fetchBusArrivals(selectedBusStop);
    fetchReverseGeocode(beaconCoords[0], beaconCoords[1]);
  }, []);

  const checkHealth = async () => {
    try {
      const res = await fetch('/api/health');
      if (res.ok) {
        const data = await res.json();
        setOnemapHealth({
          configured: data.services?.onemap?.configured ?? false,
          status: data.status,
          message: data.services?.onemap?.message
        });
      }
    } catch (e) {
      console.warn('Failed to query /api/health:', e);
    }
  };

  const fetchReverseGeocode = async (lat: number, lng: number) => {
    setIsGeocodingLoading(true);
    try {
      const res = await fetch(`/api/revgeocode?location=${lat},${lng}&buffer=40&addressType=All`);
      const json = await res.json();
      setGeocodeRawResponse(json);

      const items = json?.data?.GeocodeInfo || [];
      if (items.length > 0) {
        const first = items[0];
        setGeocodedInfo({
          building: first.BUILDING && first.BUILDING !== 'null' ? first.BUILDING : undefined,
          block: first.BLOCK && first.BLOCK !== 'null' ? first.BLOCK : undefined,
          road: first.ROAD && first.ROAD !== 'null' ? first.ROAD : undefined,
          postalCode: first.POSTALCODE && first.POSTALCODE !== 'null' ? first.POSTALCODE : undefined,
          raw: first
        });
      } else {
        setGeocodedInfo({
          building: 'Singapore Central Region',
          road: `${lat.toFixed(4)}, ${lng.toFixed(4)}`
        });
      }
    } catch (err: any) {
      console.error('Reverse geocode error:', err);
    } finally {
      setIsGeocodingLoading(false);
    }
  };

  const fetchBusArrivals = async (stopCode: string) => {
    setIsBusLoading(true);
    try {
      const res = await fetch(`/api/busarrival?busStopCode=${stopCode}`);
      if (res.ok) {
        const data = await res.json();
        setBusArrivalData(data);
      }
    } catch (err) {
      console.error('Failed to fetch bus arrival timings:', err);
    } finally {
      setIsBusLoading(false);
    }
  };

  // Initialize and maintain the Leaflet Map
  useEffect(() => {
    if (!mapContainerRef.current) return;

    if (!mapInstanceRef.current) {
      const map = L.map(mapContainerRef.current, {
        center: beaconCoords,
        zoom: 16,
        zoomControl: true,
        attributionControl: true,
      });

      mapInstanceRef.current = map;
      markersLayerRef.current = L.layerGroup().addTo(map);

      // Map click handler to trigger reverse geocoding on any point
      map.on('click', (e: L.LeafletMouseEvent) => {
        const { lat, lng } = e.latlng;
        setSelectedCoords([lat, lng]);
        fetchReverseGeocode(lat, lng);
      });

      // Force layout invalidation after DOM is painted
      setTimeout(() => {
        map.invalidateSize();
      }, 250);
    }

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Update tile layers dynamically
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;

    // Remove any existing tile layers
    map.eachLayer((layer) => {
      if (layer instanceof L.TileLayer) {
        map.removeLayer(layer);
      }
    });

    let tileUrl = 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png';
    let attribution = '<a href="https://www.onemap.gov.sg" target="_blank">OneMap</a> &copy; Singapore Land Authority';

    if (activeTileLayer === 'night') {
      tileUrl = 'https://www.onemap.gov.sg/maps/tiles/Night/{z}/{x}/{y}.png';
    } else if (activeTileLayer === 'carto') {
      tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
      attribution = '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';
    }

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 19,
      minZoom: 11,
      attribution,
    });

    tileLayer.addTo(map);
  }, [activeTileLayer]);

  // Update Markers (Beacon & Crew members)
  useEffect(() => {
    const map = mapInstanceRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;

    layer.clearLayers();

    // 1. Rendezvous Beacon Marker
    const beaconIcon = L.divIcon({
      className: 'custom-beacon-pin',
      html: `
        <div style="position: relative; width: 44px; height: 44px; display: flex; align-items: center; justify-content: center;">
          <div style="position: absolute; width: 42px; height: 42px; border-radius: 9999px; background-color: rgba(245, 158, 11, 0.35); animation: ping 2s cubic-bezier(0, 0, 0.2, 1) infinite;"></div>
          <div style="width: 32px; height: 32px; border-radius: 9999px; background-color: #f59e0b; border: 2.5px solid #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.3); display: flex; align-items: center; justify-content: center; color: #020617;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          </div>
        </div>
      `,
      iconSize: [44, 44],
      iconAnchor: [22, 22],
      popupAnchor: [0, -22],
    });

    const beaconMarker = L.marker(beaconCoords, { icon: beaconIcon }).addTo(layer);
    beaconMarker.bindPopup(`
      <div style="font-family: system-ui, sans-serif; font-size: 12px; line-height: 1.4; max-width: 220px; color: #0f172a;">
        <div style="font-size: 10px; font-weight: 700; color: #d97706; text-transform: uppercase;">Rendezvous Beacon</div>
        <strong style="font-size: 13px; display: block; margin-top: 2px;">${trip.meetupPoint.name}</strong>
        <div style="margin-top: 4px; color: #475569;">⏰ Meetup: <strong>${trip.meetupPoint.time}</strong></div>
        <div style="margin-top: 4px; font-size: 11px; background: #f8fafc; padding: 4px 6px; border-radius: 4px; border: 1px solid #e2e8f0;">${trip.meetupPoint.notes}</div>
      </div>
    `);

    // 2. Member Markers
    trip.members.forEach((member) => {
      const coords = MEMBER_COORDINATES[member.id] || [
        beaconCoords[0] + (Math.sin(member.id.charCodeAt(4)) * 0.003),
        beaconCoords[1] + (Math.cos(member.id.charCodeAt(4)) * 0.003),
      ];

      const ringColor = member.isAtMeetup ? '#10b981' : member.battery < 20 ? '#ef4444' : '#3b82f6';

      const memberIcon = L.divIcon({
        className: 'custom-member-pin',
        html: `
          <div style="position: relative; display: flex; flex-direction: column; align-items: center; width: 40px; cursor: pointer;">
            <div style="width: 32px; height: 32px; border-radius: 9999px; border: 3px solid ${ringColor}; box-shadow: 0 2px 6px rgba(0,0,0,0.3); overflow: hidden; background: #ffffff;">
              <img src="${member.avatar}" alt="${member.name}" style="width: 100%; height: 100%; object-fit: cover;" />
            </div>
            <div style="font-size: 9px; font-weight: 700; background: rgba(15, 23, 42, 0.9); color: #ffffff; padding: 1px 4px; border-radius: 4px; margin-top: 2px; white-space: nowrap; box-shadow: 0 1px 2px rgba(0,0,0,0.2);">
              ${member.name.split(' ')[0]} ${member.isAtMeetup ? '✓' : ''}
            </div>
          </div>
        `,
        iconSize: [40, 48],
        iconAnchor: [20, 24],
        popupAnchor: [0, -24],
      });

      const memberMarker = L.marker(coords, { icon: memberIcon }).addTo(layer);
      memberMarker.bindPopup(`
        <div style="font-family: system-ui, sans-serif; font-size: 12px; line-height: 1.4; color: #0f172a;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <img src="${member.avatar}" style="width: 28px; height: 28px; border-radius: 9999px; object-fit: cover;" />
            <div>
              <strong>${member.name}</strong>
              <div style="font-size: 10px; color: #64748b;">${member.role}</div>
            </div>
          </div>
          <div style="margin-top: 8px; font-size: 11px;">
            <div>📍 <strong>Location:</strong> ${member.locationName}</div>
            <div>🔋 <strong>Battery:</strong> ${member.battery}%</div>
            <div>💬 <em>"${member.status}"</em></div>
          </div>
          <div style="margin-top: 6px; font-size: 10px; font-weight: 700; color: ${member.isAtMeetup ? '#059669' : '#d97706'};">
            ${member.isAtMeetup ? '● At Meetup Point' : '○ En Route'}
          </div>
        </div>
      `);

      // Dashed connector line to beacon for active traveler
      if (member.id === activeTraveler.id && !member.isAtMeetup) {
        L.polyline([coords, beaconCoords], {
          color: '#f59e0b',
          weight: 2,
          dashArray: '5, 8',
          opacity: 0.8,
        }).addTo(layer);
      }
    });

    // 3. Temporary probe pin if user clicked a custom point
    if (
      selectedCoords &&
      (selectedCoords[0] !== beaconCoords[0] || selectedCoords[1] !== beaconCoords[1])
    ) {
      const probeIcon = L.divIcon({
        className: 'custom-probe-pin',
        html: `
          <div style="width: 20px; height: 20px; border-radius: 9999px; background: #8b5cf6; border: 2px solid #ffffff; box-shadow: 0 0 8px rgba(139, 92, 246, 0.8);"></div>
        `,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
      });

      L.marker(selectedCoords, { icon: probeIcon })
        .addTo(layer)
        .bindPopup(`OneMap Reverse Geocode Probe: ${selectedCoords[0].toFixed(4)}, ${selectedCoords[1].toFixed(4)}`)
        .openPopup();
    }
  }, [trip.members, beaconCoords, selectedCoords, activeTraveler.id]);

  // Handle setting beacon to specific preset coordinates
  const handleSetLauPaSat = () => {
    setBeaconCoords(LAU_PA_SAT_COORDS);
    setSelectedCoords(LAU_PA_SAT_COORDS);
    mapInstanceRef.current?.flyTo(LAU_PA_SAT_COORDS, 16);
    fetchReverseGeocode(LAU_PA_SAT_COORDS[0], LAU_PA_SAT_COORDS[1]);
  };

  const handleTestRequestedOnemapEndpoint = () => {
    setSelectedCoords(ONEMAP_DEMO_COORDS);
    mapInstanceRef.current?.flyTo(ONEMAP_DEMO_COORDS, 16);
    fetchReverseGeocode(ONEMAP_DEMO_COORDS[0], ONEMAP_DEMO_COORDS[1]);
  };

  // Group quick check-in for active traveler
  const handleToggleArrived = () => {
    const updatedMembers = trip.members.map((m) => {
      if (m.id === activeTraveler.id) {
        return {
          ...m,
          isAtMeetup: !m.isAtMeetup,
          status: !m.isAtMeetup ? 'Arrived at Rendezvous Point!' : 'Exploring nearby',
          lastActive: 'Just now',
        };
      }
      return m;
    });

    onUpdateTrip({
      ...trip,
      members: updatedMembers,
    });
  };

  const handleUpdateCustomStatus = (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickStatus.trim()) return;

    const updatedMembers = trip.members.map((m) => {
      if (m.id === activeTraveler.id) {
        return {
          ...m,
          status: quickStatus.trim(),
          lastActive: 'Just now',
        };
      }
      return m;
    });

    onUpdateTrip({
      ...trip,
      members: updatedMembers,
    });

    setQuickStatus('');
  };

  const handleSaveBeacon = (e: React.FormEvent) => {
    e.preventDefault();
    onUpdateTrip({
      ...trip,
      meetupPoint: {
        name: beaconName.trim(),
        time: beaconTime.trim(),
        notes: beaconNotes.trim(),
        updatedAt: `Just now by ${activeTraveler.name}`,
      },
    });
    setIsEditingBeacon(false);
    setAnnouncementBanner(`New Rendezvous Beacon set at ${beaconTime}: ${beaconName}`);
  };

  const handleSendRegroupAlert = () => {
    setAnnouncementBanner(
      `🔔 REGROUP ALERT SENT: "${activeTraveler.name} signaled the crew to head to ${trip.meetupPoint.name} for ${trip.meetupPoint.time} meetup."`
    );
  };

  const arrivedCount = trip.members.filter((m) => m.isAtMeetup).length;

  return (
    <div className="space-y-6">
      {/* Broadcast Alert Banner */}
      {announcementBanner && (
        <div className="bg-amber-500 text-slate-950 p-3.5 rounded-xl text-xs font-semibold flex items-center justify-between shadow-xs animate-in fade-in">
          <div className="flex items-center gap-2">
            <Bell className="w-4 h-4 shrink-0" />
            <span>{announcementBanner}</span>
          </div>
          <button
            onClick={() => setAnnouncementBanner(null)}
            className="p-1 hover:bg-amber-600/20 rounded cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Rendezvous Beacon Banner */}
      <div className="bg-slate-900 text-white rounded-2xl p-6 border border-slate-800 shadow-md">
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-400">
              <Navigation className="w-4 h-4" />
              <span>ACTIVE GROUP RENDEZVOUS BEACON</span>
              <span aria-hidden="true">·</span>
              <span className="text-slate-400 font-normal">{trip.meetupPoint.updatedAt}</span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white">
              {trip.meetupPoint.name}
            </h2>
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-300">
              <span className="flex items-center gap-1.5 font-semibold text-white">
                <Clock className="w-4 h-4 text-amber-400" />
                Meetup Time: {trip.meetupPoint.time}
              </span>
              <span aria-hidden="true">·</span>
              <span>{trip.meetupPoint.notes}</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0 w-full md:w-auto">
            <button
              onClick={() => setIsEditingBeacon(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 bg-white/10 hover:bg-white/15 rounded-lg border border-white/10 transition-colors cursor-pointer"
            >
              <Edit2 className="w-3.5 h-3.5" />
              <span>Edit Beacon</span>
            </button>
            <button
              onClick={handleSendRegroupAlert}
              className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors shadow-xs cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5" />
              <span>Ping Crew</span>
            </button>
          </div>
        </div>

        {/* Check-in Progress Bar */}
        <div className="mt-6 pt-5 border-t border-slate-800/80 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="text-xs">
              <span className="text-slate-400">Attendance: </span>
              <strong className="text-white font-tabular">{arrivedCount} of {trip.members.length} Arrived</strong>
            </div>
            <div className="flex -space-x-1.5">
              {trip.members.map((m) => (
                <img
                  key={m.id}
                  src={m.avatar}
                  alt={m.name}
                  title={`${m.name}: ${m.isAtMeetup ? 'At Meetup' : 'En route'}`}
                  className={`w-6 h-6 rounded-full object-cover ring-2 ${
                    m.isAtMeetup ? 'ring-emerald-400' : 'ring-slate-700 opacity-60'
                  }`}
                  referrerPolicy="no-referrer"
                />
              ))}
            </div>
          </div>

          <button
            onClick={handleToggleArrived}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer ${
              activeTraveler.isAtMeetup
                ? 'bg-emerald-600 text-white shadow-xs'
                : 'bg-white text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Check className="w-4 h-4" />
            <span>
              {activeTraveler.isAtMeetup
                ? `You're Checked In as ${activeTraveler.name.split(' ')[0]}!`
                : `I Have Arrived (${activeTraveler.name.split(' ')[0]})`}
            </span>
          </button>
        </div>
      </div>

      {/* Interactive Map & OneMap Telematics Canvas */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-xs">
        {/* Map Header with Controls */}
        <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-slate-50/60">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-900">
                Live Rendezvous Map · Singapore OneMap Spatial View
              </h3>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
                Live GPS
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5">
              Real-time proximity, member tracking, and Singapore Land Authority OneMap telemetry. Click anywhere on map to reverse-geocode.
            </p>
          </div>

          {/* Quick presets & Layer switches */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={handleSetLauPaSat}
              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-white border border-slate-200 hover:border-slate-300 text-slate-700 shadow-2xs cursor-pointer"
            >
              Lau Pa Sat
            </button>
            <button
              onClick={handleTestRequestedOnemapEndpoint}
              title="Test endpoint: location=1.2979,103.8489&buffer=40&addressType=All"
              className="px-2.5 py-1 text-xs font-medium rounded-lg bg-amber-50 border border-amber-200 hover:border-amber-300 text-amber-800 shadow-2xs flex items-center gap-1 cursor-pointer"
            >
              <MapPin className="w-3 h-3 text-amber-600" />
              <span>Test 1.2979, 103.8489</span>
            </button>
            <div className="h-4 w-px bg-slate-200 mx-1 hidden sm:block"></div>
            <div className="flex items-center bg-slate-200/70 p-0.5 rounded-lg text-xs">
              <button
                onClick={() => setActiveTileLayer('onemap')}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTileLayer === 'onemap' ? 'bg-white text-slate-900 font-bold shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                OneMap
              </button>
              <button
                onClick={() => setActiveTileLayer('night')}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTileLayer === 'night' ? 'bg-white text-slate-900 font-bold shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Night
              </button>
              <button
                onClick={() => setActiveTileLayer('carto')}
                className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                  activeTileLayer === 'carto' ? 'bg-white text-slate-900 font-bold shadow-2xs' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Voyager
              </button>
            </div>
          </div>
        </div>

        {/* Live Interactive Leaflet Map Container */}
        <div className="relative">
          <div 
            ref={mapContainerRef} 
            className="w-full h-[400px] z-10 bg-slate-100"
            style={{ minHeight: '380px' }}
          />

          {/* Quick Legend Overlay */}
          <div className="absolute bottom-3 left-3 z-20 bg-white/95 backdrop-blur-xs p-2.5 rounded-xl border border-slate-200/80 shadow-md text-[11px] space-y-1">
            <div className="font-bold text-slate-800 text-[10px] uppercase tracking-wider mb-1">Map Legend</div>
            <div className="flex items-center gap-1.5 text-slate-700">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block"></span>
              <span>Meetup Beacon ({trip.meetupPoint.time})</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-700">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
              <span>Arrived at Meetup</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-700">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block"></span>
              <span>En route / Exploring</span>
            </div>
            <div className="flex items-center gap-1.5 text-slate-700">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span>
              <span>Low Battery (&lt;20%)</span>
            </div>
          </div>
        </div>

        {/* Live OneMap Reverse Geocode Telematics Panel */}
        <div className="p-4 bg-slate-900 text-white border-t border-slate-800">
          <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-amber-400/10 text-amber-400 border border-amber-400/20 shrink-0">
                <MapPin className="w-4 h-4" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-bold tracking-wider text-amber-400 uppercase">
                    OneMap Reverse Geocoded Landmark
                  </span>
                  {isGeocodingLoading && (
                    <RefreshCw className="w-3 h-3 text-slate-400 animate-spin" />
                  )}
                  <span className="text-[10px] text-slate-400">
                    ({selectedCoords[0].toFixed(4)}, {selectedCoords[1].toFixed(4)})
                  </span>
                </div>
                <div className="text-sm font-bold text-white mt-0.5">
                  {geocodedInfo?.building || geocodedInfo?.road || 'Resolving Singapore building...'}
                </div>
                <div className="text-xs text-slate-400 flex flex-wrap items-center gap-2 mt-0.5">
                  {geocodedInfo?.block && <span>Blk {geocodedInfo.block}</span>}
                  {geocodedInfo?.road && <span>{geocodedInfo.road}</span>}
                  {geocodedInfo?.postalCode && (
                    <span className="bg-slate-800 px-1.5 py-0.5 rounded text-[11px] font-mono text-slate-300">
                      S({geocodedInfo.postalCode})
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto justify-end">
              <button
                onClick={() => setShowJsonInspector(!showJsonInspector)}
                className="px-2.5 py-1 text-[11px] font-medium text-slate-300 bg-slate-800 hover:bg-slate-700 rounded-lg border border-slate-700 transition-colors cursor-pointer"
              >
                {showJsonInspector ? 'Hide Raw API JSON' : 'Inspect API Response'}
              </button>
              <button
                onClick={() => fetchReverseGeocode(selectedCoords[0], selectedCoords[1])}
                disabled={isGeocodingLoading}
                className="px-3 py-1 text-xs font-semibold text-slate-900 bg-amber-400 hover:bg-amber-300 rounded-lg transition-colors flex items-center gap-1 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isGeocodingLoading ? 'animate-spin' : ''}`} />
                <span>Re-query</span>
              </button>
            </div>
          </div>

          {/* Raw JSON Inspector Drawer */}
          {showJsonInspector && (
            <div className="mt-3 pt-3 border-t border-slate-800 text-[11px] font-mono">
              <div className="flex items-center justify-between text-slate-400 mb-1">
                <span>GET /api/revgeocode?location={selectedCoords.join(',')}&buffer=40&addressType=All</span>
                <span className="text-[10px] text-amber-400">
                  {onemapHealth?.configured ? 'Live OneMap Token Connected' : 'Waiting for ONEMAP_TOKEN'}
                </span>
              </div>
              <pre className="bg-slate-950 p-3 rounded-lg text-slate-300 overflow-x-auto max-h-40 border border-slate-800 text-[10px]">
                {JSON.stringify(geocodeRawResponse || { status: 'loading' }, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Live Public Bus Arrival Feed */}
        <div className="p-4 border-t border-slate-200 bg-white">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <Bus className="w-4 h-4 text-emerald-600" />
              <div>
                <h4 className="text-xs font-bold text-slate-900">
                  Nearby Singapore Public Transit & Bus Arrivals
                </h4>
                <p className="text-[11px] text-slate-500">
                  Live arrival times for friends transiting to the rendezvous beacon via SBS & Tower Transit.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              {/* Bus stop selector */}
              <select
                value={selectedBusStop}
                onChange={(e) => {
                  setSelectedBusStop(e.target.value);
                  fetchBusArrivals(e.target.value);
                }}
                className="text-xs bg-slate-50 border border-slate-300 rounded-lg px-2.5 py-1 text-slate-800 focus:outline-hidden focus:ring-1 focus:ring-slate-900"
              >
                <option value="03079">Stop 03079 - Lau Pa Sat (Raffles Quay)</option>
                <option value="03059">Stop 03059 - Telok Ayer Stn / Opp SO</option>
                <option value="03041">Stop 03041 - Telok Ayer Stn Exit A</option>
              </select>

              <button
                onClick={() => fetchBusArrivals(selectedBusStop)}
                disabled={isBusLoading}
                className="p-1.5 rounded-lg border border-slate-200 hover:bg-slate-50 text-slate-600 cursor-pointer disabled:opacity-50"
                title="Refresh arrival countdowns"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isBusLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {/* Bus cards grid */}
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2.5">
            {busArrivalData?.services?.map((svc) => (
              <div
                key={svc.serviceNo}
                className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex flex-col justify-between"
              >
                <div className="flex items-center justify-between">
                  <span className="font-extrabold text-sm text-slate-950 font-tabular bg-white px-2 py-0.5 rounded border border-slate-200">
                    Bus {svc.serviceNo}
                  </span>
                  <span className="text-[10px] text-slate-500">{svc.operator}</span>
                </div>

                <div className="mt-2 space-y-1">
                  <div className="flex items-baseline gap-1">
                    <span className="text-lg font-bold text-emerald-700 font-tabular">
                      {svc.nextBus.estimatedArrivalMins}
                    </span>
                    <span className="text-[11px] text-slate-600 font-medium">mins</span>
                  </div>

                  <div className="text-[10px] text-slate-500 flex items-center justify-between">
                    <span className={svc.nextBus.load === 'Seats Available' ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>
                      {svc.nextBus.load}
                    </span>
                    {svc.subsequentBus && (
                      <span className="text-slate-400">Next: {svc.subsequentBus.estimatedArrivalMins}m</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2.5 flex items-center justify-between text-[11px] text-slate-400">
            <span>Stop: {busArrivalData?.busStopName || 'Lau Pa Sat'} ({busArrivalData?.roadName || 'Raffles Quay'})</span>
            <span>Serverless route: <code className="bg-slate-100 px-1 py-0.5 rounded text-[10px]">/api/busarrival</code></span>
          </div>
        </div>
      </div>

      {/* Member Status Grid & Quick Update */}
      <div className="space-y-4">
        {/* Quick status bar for active traveler */}
        <form onSubmit={handleUpdateCustomStatus} className="bg-white p-4 rounded-xl border border-slate-200 flex gap-2 shadow-xs">
          <input
            type="text"
            value={quickStatus}
            onChange={(e) => setQuickStatus(e.target.value)}
            placeholder={`Broadcast quick note to group as ${activeTraveler.name} (e.g. "Grabbing satay skewers from Stall 6, be there in 2 mins")...`}
            className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-slate-900 text-slate-900"
          />
          <button
            type="submit"
            className="px-3.5 py-1.5 text-xs font-semibold bg-slate-900 hover:bg-slate-800 text-white rounded-lg flex items-center gap-1.5 shrink-0 cursor-pointer"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Post Status</span>
          </button>
        </form>

        {/* Member cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {trip.members.map((member) => {
            const isLowBattery = member.battery < 20;
            return (
              <div
                key={member.id}
                className={`bg-white rounded-xl border p-4 shadow-xs transition-all ${
                  member.isAtMeetup ? 'border-emerald-200 bg-emerald-50/15' : 'border-slate-200'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <img
                      src={member.avatar}
                      alt={member.name}
                      className="w-10 h-10 rounded-full object-cover shrink-0"
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <div className="font-bold text-slate-900 text-xs flex items-center gap-1.5">
                        <span>{member.name}</span>
                        {member.id === activeTraveler.id && (
                          <span className="text-[10px] text-slate-500 font-normal">(You)</span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400">{member.role}</div>
                    </div>
                  </div>

                  {/* Battery Indicator */}
                  <div className="flex items-center gap-1 text-[11px] text-slate-500 font-tabular">
                    {isLowBattery ? (
                      <BatteryWarning className="w-4 h-4 text-rose-500" />
                    ) : (
                      <Battery className="w-4 h-4 text-slate-400" />
                    )}
                    <span className={isLowBattery ? 'text-rose-600 font-bold' : ''}>
                      {member.battery}%
                    </span>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
                  <div className="flex items-start gap-1.5 text-slate-700">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                    <span className="font-medium truncate">{member.locationName}</span>
                  </div>

                  <p className="text-[11px] text-slate-600 italic bg-slate-50 p-1.5 rounded">
                    "{member.status}"
                  </p>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 pt-1">
                    <span>Active: {member.lastActive}</span>
                    <span className={member.isAtMeetup ? 'text-emerald-700 font-bold' : 'text-slate-500'}>
                      {member.isAtMeetup ? 'At Meetup Beacon' : 'Away'}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Edit Beacon Modal */}
      {isEditingBeacon && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl border border-slate-200 animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between pb-3 border-b border-slate-100">
              <h3 className="text-base font-bold text-slate-900">Set Rendezvous Beacon</h3>
              <button onClick={() => setIsEditingBeacon(false)} className="p-1 text-slate-400 hover:text-slate-600 cursor-pointer">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSaveBeacon} className="space-y-4 pt-4 text-xs">
              <div>
                <label className="font-semibold text-slate-700 block mb-1">Meetup Location / Landmark *</label>
                <input
                  type="text"
                  required
                  value={beaconName}
                  onChange={(e) => setBeaconName(e.target.value)}
                  placeholder="e.g. Lau Pa Sat Festival Market (Boon Tat St Satay Street)"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-slate-900 text-slate-900"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">Meetup Time *</label>
                <input
                  type="text"
                  required
                  value={beaconTime}
                  onChange={(e) => setBeaconTime(e.target.value)}
                  placeholder="18:30"
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-slate-900 text-slate-900 font-tabular"
                />
              </div>

              <div>
                <label className="font-semibold text-slate-700 block mb-1">Note for Crew</label>
                <textarea
                  rows={2}
                  value={beaconNotes}
                  onChange={(e) => setBeaconNotes(e.target.value)}
                  placeholder="e.g. Priya is choping Table 18. Alex bringing cash for Satay Stalls 7 & 8."
                  className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-slate-900 text-slate-900"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setIsEditingBeacon(false)}
                  className="px-4 py-2 font-medium text-slate-600 hover:text-slate-800 rounded-lg cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg shadow-sm cursor-pointer"
                >
                  Broadcast New Beacon
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
