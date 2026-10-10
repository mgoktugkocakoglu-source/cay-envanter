// @google/earthengine ships no type definitions; it is used through a narrow surface in src/ee/.
declare module '@google/earthengine' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ee: any;
    export default ee;
}
