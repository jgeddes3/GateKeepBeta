import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import MapView, { Marker, type LatLng, type Region } from "react-native-maps";
import { SEARCH_EMPTY_MESSAGE, type SearchPin } from "@gatekeep/shared";
import { IconMapPin, Text } from "../ui";
import { useTokens } from "../theme/ThemeProvider";
import { tokens } from "../theme/tokens";

// SP8 Task 16: the mobile twin of apps/web/src/search/ResultsMap.tsx, built
// on react-native-maps rather than the browser's own Maps JS loader (there
// is no equivalent "load once, key-gated" story on mobile: iOS renders on
// Apple Maps with no key at all, Android needs the app.json
// android.config.googleMaps.apiKey this task also adds).
//
// A sensible region size for "somewhere in one city", not a tight fit:
// fitToCoordinates (below) takes over the instant the map itself is ready,
// so this only has to look reasonable for the single frame before that.
const FALLBACK_DELTA = 0.2;
const FIT_EDGE_PADDING = { top: 48, right: 48, bottom: 48, left: 48 };

function pinCoordinate(pin: SearchPin): LatLng {
  return { latitude: pin.geo.lat, longitude: pin.geo.lng };
}

// Shared by FanFace and MusicianFace's gigs segment: the device location
// (useDeckLocation), when known, always wins as the initial region: it
// centres the map on the searcher before any pin has even loaded. Neither
// caller has to restate FALLBACK_DELTA itself, and when there is no
// location yet (still resolving, denied, or never granted) this returns
// undefined so ResultsMap falls back to the first pin on its own.
export function regionFromLocation(location: { lat: number; lng: number } | null): Region | undefined {
  return location
    ? { latitude: location.lat, longitude: location.lng, latitudeDelta: FALLBACK_DELTA, longitudeDelta: FALLBACK_DELTA }
    : undefined;
}

// Fix round 1 (important #1): mapReady lives on this inner component, not
// on ResultsMap itself, and ResultsMap only ever mounts it once pins is
// non-empty (see below). That makes "mapReady starts false, then flips
// true from THIS instance's own onMapReady" a structural guarantee rather
// than something a manual reset has to remember: pins going empty
// unmounts this component entirely (ResultsMap's early return swaps in
// the empty state instead), so a later non-empty pins array always mounts
// a brand new MapView with a brand new, false-by-default mapReady, and
// the pins-change effect can never fire fitToCoordinates against a map
// that hasn't called onMapReady yet.
function MapWithPins({ pins, onSelect, region }: {
  pins: SearchPin[];
  onSelect: (pin: SearchPin) => void;
  region: Region;
}) {
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);

  // Reruns on every pins change once the map itself is ready, so a filter
  // or query change while the map view is already open still reframes it;
  // animated: false matches web's own "jump, don't animate" fitBounds call.
  useEffect(() => {
    if (!mapReady) return;
    mapRef.current?.fitToCoordinates(pins.map(pinCoordinate), {
      edgePadding: FIT_EDGE_PADDING,
      animated: false,
    });
  }, [pins, mapReady]);

  return (
    <MapView
      ref={mapRef}
      style={{ height: 380, borderRadius: tokens.radius.card, overflow: "hidden" }}
      initialRegion={region}
      showsUserLocation={false}
      onMapReady={() => setMapReady(true)}
    >
      {pins.map((pin) => (
        <Marker
          key={pin.id}
          coordinate={pinCoordinate(pin)}
          title={pin.title}
          description={pin.subtitle}
          onPress={() => onSelect(pin)}
        />
      ))}
    </MapView>
  );
}

export function ResultsMap({ pins, onSelect, initialRegion }: {
  pins: SearchPin[];
  onSelect: (pin: SearchPin) => void;
  initialRegion?: Region;
}) {
  const t = useTokens();

  if (pins.length === 0) {
    return (
      <View style={{ alignItems: "center", gap: tokens.space.sm, paddingVertical: tokens.space.xl }}>
        <IconMapPin size={48} color={t.muted} />
        <Text variant="heading" style={{ textAlign: "center" }}>Nothing on the map yet</Text>
        <Text muted style={{ textAlign: "center" }}>{SEARCH_EMPTY_MESSAGE}</Text>
      </View>
    );
  }

  const region = initialRegion ?? {
    latitude: pins[0].geo.lat,
    longitude: pins[0].geo.lng,
    latitudeDelta: FALLBACK_DELTA,
    longitudeDelta: FALLBACK_DELTA,
  };

  return <MapWithPins pins={pins} onSelect={onSelect} region={region} />;
}
