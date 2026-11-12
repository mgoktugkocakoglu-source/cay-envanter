import type { MultiPolygon, Polygon } from 'geojson';

type Poly = Polygon | MultiPolygon;

/**
 * KML for Google Earth. TKGM's parcel query returns WGS84 longitude/latitude (ITRF96, identical at this precision),
 * which is the datum KML uses: the coordinates go in unchanged, no transformation.
 *
 * What does differ is the imagery under the polygon: on steep terrain Google Earth's orthorectification is off by
 * several metres (up to ~15 m in mountains), and the offset changes with the image date. `shiftM` moves a COPY of the
 * outline by metres east / north for visual alignment only; the stored cadastral geometry never changes.
 */
const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function shiftGeometry(geometry: Poly, eastM: number, northM: number): Poly {
    const move = ([lng, lat]: number[]): number[] => [(lng as number) + eastM / (111_320 * Math.cos(((lat as number) * Math.PI) / 180)), (lat as number) + northM / 110_540];
    return geometry.type === 'Polygon' ? { type: 'Polygon', coordinates: geometry.coordinates.map((ring) => ring.map(move)) } : { type: 'MultiPolygon', coordinates: geometry.coordinates.map((poly) => poly.map((ring) => ring.map(move))) };
}

function polygonKml(geometry: Poly): string {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    const ring = (r: number[][]) => r.map(([lng, lat]) => `${lng},${lat},0`).join(' ');
    const body = polygons
        .map((rings) => `<Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${ring(rings[0] as number[][])}</coordinates></LinearRing></outerBoundaryIs>${rings.slice(1).map((r) => `<innerBoundaryIs><LinearRing><coordinates>${ring(r)}</coordinates></LinearRing></innerBoundaryIs>`).join('')}</Polygon>`)
        .join('');
    return polygons.length > 1 ? `<MultiGeometry>${body}</MultiGeometry>` : body;
}

export function parcelKml(parcels: Array<{ name: string; description: string; geometry: Poly }>, buildings: Poly[] = [], shiftM: { east: number; north: number } | null = null): string {
    const placemark = (name: string, description: string, style: string, geometry: Poly) => `<Placemark><name>${escapeXml(name)}</name><description>${escapeXml(description)}</description><styleUrl>#${style}</styleUrl>${polygonKml(geometry)}</Placemark>`;
    const shifted = shiftM && (shiftM.east !== 0 || shiftM.north !== 0) ? parcels.map((p) => placemark(`${p.name} (görüntüye hizalı: ${shiftM.east} m doğu, ${shiftM.north} m kuzey)`, 'Yalnız görsel hizalama; kadastro geometrisi değildir.', 'shifted', shiftGeometry(p.geometry, shiftM.east, shiftM.north))) : [];
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${escapeXml(parcels.map((p) => p.name).join(', '))}</name>
<Style id="parcel"><LineStyle><color>ff00ffff</color><width>3</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="shifted"><LineStyle><color>ff00a5ff</color><width>2</width></LineStyle><PolyStyle><fill>0</fill></PolyStyle></Style>
<Style id="building"><LineStyle><color>ff0000ff</color><width>2</width></LineStyle><PolyStyle><color>330000ff</color></PolyStyle></Style>
<Folder><name>Parsel (TKGM)</name>${parcels.map((p) => placemark(p.name, p.description, 'parcel', p.geometry)).join('')}${shifted.join('')}</Folder>
${buildings.length ? `<Folder><name>Yapı izleri</name>${buildings.map((b, i) => placemark(`Yapı ${i + 1}`, 'Microsoft bina izi', 'building', b)).join('')}</Folder>` : ''}
</Document></kml>
`;
}
