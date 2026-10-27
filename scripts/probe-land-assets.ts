// One-off: confirm the Earth Engine assets the land-evaluation module relies on exist and list their bands.
import { initEarthEngine, evaluate } from '../src/ee/session.ts';

const ee = await initEarthEngine();
const probes: Array<[string, () => any]> = [
    ['COPERNICUS/DEM/GLO30', () => ee.ImageCollection('COPERNICUS/DEM/GLO30').first().bandNames()],
    ['MERIT/Hydro/v1_0_1', () => ee.Image('MERIT/Hydro/v1_0_1').bandNames()],
    ['JRC/GSW1_4/GlobalSurfaceWater', () => ee.Image('JRC/GSW1_4/GlobalSurfaceWater').bandNames()],
    ['GOOGLE/DYNAMICWORLD/V1', () => ee.ImageCollection('GOOGLE/DYNAMICWORLD/V1').first().bandNames()],
    ['ESA/WorldCover/v200', () => ee.ImageCollection('ESA/WorldCover/v200').first().bandNames()],
    ['soilgrids clay', () => ee.Image('projects/soilgrids-isric/clay_mean').bandNames()],
    ['soilgrids phh2o', () => ee.Image('projects/soilgrids-isric/phh2o_mean').bandNames()],
    ['soilgrids soc', () => ee.Image('projects/soilgrids-isric/soc_mean').bandNames()],
    ['soilgrids sand', () => ee.Image('projects/soilgrids-isric/sand_mean').bandNames()],
    ['soilgrids silt', () => ee.Image('projects/soilgrids-isric/silt_mean').bandNames()],
    ['soilgrids cec', () => ee.Image('projects/soilgrids-isric/cec_mean').bandNames()],
    ['soilgrids bdod', () => ee.Image('projects/soilgrids-isric/bdod_mean').bandNames()],
    ['OpenLandMap texture', () => ee.Image('OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02').bandNames()],
    ['ERA5_LAND/DAILY_AGGR', () => ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR').filterDate('2026-09-01', '2026-10-01').first().bandNames()],
    ['ERA5_LAND latest', () => ee.ImageCollection('ECMWF/ERA5_LAND/DAILY_AGGR').filterDate('2026-01-01', '2027-01-01').aggregate_max('system:time_start')],
    ['CHIRPS/DAILY', () => ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY').filterDate('2026-01-01', '2027-01-01').aggregate_max('system:time_start')],
    ['WWF HydroRIVERS', () => ee.FeatureCollection('WWF/HydroSHEDS/v1/FreeFlowingRivers').limit(1).first().propertyNames()],
];
for (const [name, build] of probes) {
    try {
        const v = await evaluate<unknown>(build());
        console.log(`OK  ${name}: ${JSON.stringify(v).slice(0, 220)}`);
    } catch (e) {
        console.log(`ERR ${name}: ${String(e).slice(0, 160)}`);
    }
}
