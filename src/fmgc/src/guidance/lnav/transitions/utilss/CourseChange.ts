/**
 * Functions for figuring out an appropriate course change for leg captures
 */
export class CourseChange {
    static normal(
        turnDirection: number,
        turnCenterDistance: NauticalMiles,
        trackChange: Degrees,
        radius: NauticalMiles,
    ): Degrees {
        const interceptAngleSign = Math.abs(turnCenterDistance) >= radius ? -1 : 1;

        return turnDirection * (Math.abs(trackChange) + interceptAngleSign * 45);
    }

    static acute(
        turnDirection: number,
        turnCenterDistance: NauticalMiles,
        trackChange: Degrees,
        radius: NauticalMiles,
    ): Degrees {
        // From same side
        if ((trackChange > 0 && turnCenterDistance >= radius) || (trackChange < 0 && turnCenterDistance <= -radius)) {
            return turnDirection * (45 - Math.abs(trackChange));
        }

        // From other side (course overshoot)
        return turnDirection * (Math.abs(trackChange) + 45);
    }
}
