import { Geometry } from '@fmgc/guidance/Geometry';
import { Fmgc } from '@fmgc/guidance/GuidanceController';
import { AltitudeConstraintType, SpeedConstraintType } from '@fmgc/guidance/lnav/legs';
import { FlightPlanManager } from '@fmgc/flightplanning/FlightPlanManager';
import { SegmentType } from '@fmgc/wtsdk';
import { EngineModel } from '../EngineModel';
import { FlapConf } from '../common';
import { VerticalCheckpoint, VerticalCheckpointReason } from './ClimbProfileBuilderResult';
import { Predictions, StepResults } from '../Predictions';
import { GeometryProfile } from '../GeometryProfile';
import { AtmosphericConditions } from '../AtmosphericConditions';

export class ClimbPathBuilder {
    private static TONS_TO_POUNDS = 2240;

    private atmosphericConditions: AtmosphericConditions = new AtmosphericConditions();

    private airfieldElevation: Feet;

    private accelerationAltitude: Feet;

    private thrustReductionAltitude: Feet;

    private cruiseAltitude: Feet;

    private climbSpeedLimit: Knots;

    private climbSpeedLimitAltitude: Feet;

    private perfFactor: number;

    private fcuAltitude: Feet;

    constructor(private fmgc: Fmgc, private flightPlanManager: FlightPlanManager) {
        // TODO: Hook this up to the actual MCDU field
        SimVar.SetSimVarValue('L:A32NX_STATUS_PERF_FACTOR', 'Percent', 0);
    }

    update() {
        this.airfieldElevation = SimVar.GetSimVarValue('L:A32NX_DEPARTURE_ELEVATION', 'feet');
        this.accelerationAltitude = SimVar.GetSimVarValue('L:AIRLINER_ACC_ALT', 'number');
        this.thrustReductionAltitude = SimVar.GetSimVarValue('L:AIRLINER_THR_RED_ALT', 'number');
        this.cruiseAltitude = SimVar.GetSimVarValue('L:AIRLINER_CRUISE_ALTITUDE', 'number');
        this.climbSpeedLimit = 250; // TODO: Make dynamic
        this.climbSpeedLimitAltitude = 10000; // TODO: Make dynamic
        this.perfFactor = SimVar.GetSimVarValue('L:A32NX_STATUS_PERF_FACTOR', 'Percent');
        this.fcuAltitude = Simplane.getAutoPilotDisplayedAltitudeLockValue();

        this.atmosphericConditions.update();
    }

    computeClimbPath(geometry: Geometry): GeometryProfile {
        const isOnGround = SimVar.GetSimVarValue('SIM ON GROUND', 'Bool');

        const altitudeConstraints = this.findMaxAltitudeConstraints(geometry);
        const speedConstraints = this.findMaxSpeedConstraints(geometry);

        console.log('altitude constraints:', altitudeConstraints);
        console.log('speed constraints:', speedConstraints);

        if (!isOnGround) {
            return this.computeLivePrediction(geometry);
        }

        if (!this.canComputeProfile()) {
            return null;
        }

        return this.computePreflightPrediction(geometry);
    }

    computePreflightPrediction(geometry: Geometry): GeometryProfile {
        const checkpoints: VerticalCheckpoint[] = [];

        this.addTakeoffRollCheckpoint(checkpoints, this.fmgc.getFOB() * ClimbPathBuilder.TONS_TO_POUNDS);
        this.addTakeoffStepCheckpoint(checkpoints, this.airfieldElevation, this.thrustReductionAltitude);
        this.addAccelerationAltitudeStep(checkpoints, this.thrustReductionAltitude, this.accelerationAltitude, this.fmgc.getV2Speed() + 10);

        if (this.climbSpeedLimitAltitude > this.accelerationAltitude && this.climbSpeedLimitAltitude < this.cruiseAltitude) {
            this.addClimbSteps(geometry, checkpoints, this.climbSpeedLimitAltitude, VerticalCheckpointReason.CrossingSpeedLimit);
        }

        this.addClimbSteps(geometry, checkpoints, this.cruiseAltitude, VerticalCheckpointReason.TopOfClimb);
        this.addSpeedConstraintsAsCheckpoints(checkpoints, geometry);

        return new GeometryProfile(geometry, checkpoints);
    }

    /**
     * Compute climb profile assuming climb thrust until top of climb. This does not care if we're below acceleration/thrust reduction altitude.
     * @param geometry
     * @returns
     */
    computeLivePrediction(geometry: Geometry): GeometryProfile {
        const checkpoints: VerticalCheckpoint[] = [];

        const currentAltitude = SimVar.GetSimVarValue('INDICATED ALTITUDE', 'feet');

        this.addPresentPositionCheckpoint(geometry, checkpoints, currentAltitude);
        if (this.climbSpeedLimitAltitude > currentAltitude && this.climbSpeedLimitAltitude < this.cruiseAltitude) {
            this.addClimbSteps(geometry, checkpoints, this.climbSpeedLimitAltitude, VerticalCheckpointReason.CrossingSpeedLimit);
        }

        this.addClimbSteps(geometry, checkpoints, this.cruiseAltitude, VerticalCheckpointReason.TopOfClimb);
        this.addSpeedConstraintsAsCheckpoints(checkpoints, geometry);

        return new GeometryProfile(geometry, checkpoints);
    }

    private addPresentPositionCheckpoint(geometry: Geometry, checkpoints: VerticalCheckpoint[], altitude: Feet) {
        checkpoints.push({
            reason: VerticalCheckpointReason.PresentPosition,
            distanceFromStart: this.computeDistanceFromOriginToPresentPosition(geometry),
            altitude,
            remainingFuelOnBoard: this.fmgc.getFOB() * ClimbPathBuilder.TONS_TO_POUNDS,
            speed: SimVar.GetSimVarValue('AIRSPEED INDICATED', 'knots'),
        });
    }

    private addTakeoffStepCheckpoint(checkpoints: VerticalCheckpoint[], groundAltitude: Feet, thrustReductionAltitude: Feet) {
        const midwayAltitudeSrs = (thrustReductionAltitude + groundAltitude) / 2;
        const predictedN1 = SimVar.GetSimVarValue('L:A32NX_AUTOTHRUST_THRUST_LIMIT_TOGA', 'Percent');
        const flapsSetting: FlapConf = SimVar.GetSimVarValue('L:A32NX_TO_CONFIG_FLAPS', 'Enum');
        const speed = this.fmgc.getV2Speed() + 10;
        const machSrs = this.atmosphericConditions.computeMachFromCas(midwayAltitudeSrs, speed);
        const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;

        const { fuelBurned, distanceTraveled } = Predictions.altitudeStep(
            groundAltitude,
            thrustReductionAltitude - groundAltitude,
            speed,
            machSrs,
            predictedN1,
            this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
            remainingFuelOnBoard,
            0,
            this.atmosphericConditions.isaDeviation,
            this.fmgc.getTropoPause(),
            false,
            flapsSetting,
            this.perfFactor,
        );

        checkpoints.push({
            reason: VerticalCheckpointReason.ThrustReductionAltitude,
            distanceFromStart: checkpoints[checkpoints.length - 1].distanceFromStart + distanceTraveled,
            altitude: this.thrustReductionAltitude,
            remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
            speed,
        });
    }

    private addAccelerationAltitudeStep(checkpoints: VerticalCheckpoint[], startingAltitude: Feet, targetAltitude: Feet, speed: Knots) {
        const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;
        const { fuelBurned, distanceTraveled } = this.computeClimbSegmentPrediction(startingAltitude, targetAltitude, speed, remainingFuelOnBoard);

        checkpoints.push({
            reason: VerticalCheckpointReason.AccelerationAltitude,
            distanceFromStart: checkpoints[checkpoints.length - 1].distanceFromStart + distanceTraveled,
            altitude: this.accelerationAltitude,
            remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
            speed,
        });
    }

    private addClimbSteps(geometry: Geometry, checkpoints: VerticalCheckpoint[], finalAltitude: Feet, finalAltitudeReason: VerticalCheckpointReason = VerticalCheckpointReason.AtmosphericConditions) {
        const constraints = this.findMaxAltitudeConstraints(geometry);

        for (const constraint of constraints) {
            const { maxAltitude: constraintAltitude, distanceFromStart: constraintDistanceFromStart } = constraint;

            if (constraintAltitude >= finalAltitude) {
                break;
            }

            if (constraintAltitude > checkpoints[checkpoints.length - 1].altitude) {
                // Continue climb
                if (checkpoints[checkpoints.length - 1].reason === VerticalCheckpointReason.WaypointWithConstraint) {
                    checkpoints[checkpoints.length - 1].reason = VerticalCheckpointReason.ContinueClimb;
                }

                this.buildIteratedClimbSegment(geometry, checkpoints, checkpoints[checkpoints.length - 1].altitude, constraintAltitude);

                // We reach the target altitude before the constraint, so we insert a level segment.
                if (checkpoints[checkpoints.length - 1].distanceFromStart < constraintDistanceFromStart) {
                    checkpoints[checkpoints.length - 1].reason = VerticalCheckpointReason.LevelOffForConstraint;

                    this.addLevelSegmentSteps(geometry, checkpoints, constraintDistanceFromStart);
                }
            } else if (Math.abs(checkpoints[checkpoints.length - 1].altitude - constraintAltitude) < 1) {
                // Continue in level flight to the next constraint
                this.addLevelSegmentSteps(geometry, checkpoints, constraintDistanceFromStart);
            }
        }

        if (checkpoints[checkpoints.length - 1].reason === VerticalCheckpointReason.WaypointWithConstraint) {
            checkpoints[checkpoints.length - 1].reason = VerticalCheckpointReason.ContinueClimb;
        }

        this.buildIteratedClimbSegment(geometry, checkpoints, checkpoints[checkpoints.length - 1].altitude, finalAltitude);
        checkpoints[checkpoints.length - 1].reason = finalAltitudeReason;
    }

    private buildIteratedClimbSegment(geometry: Geometry, checkpoints: VerticalCheckpoint[], startingAltitude: Feet, targetAltitude: Feet): void {
        for (let altitude = startingAltitude; altitude < targetAltitude; altitude = Math.min(altitude + 1500, targetAltitude)) {
            const distanceAtStartOfStep = checkpoints[checkpoints.length - 1].distanceFromStart;
            const climbSpeed = Math.min(
                altitude >= this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
                this.findMaxSpeedAtDistanceAlongTrack(geometry, distanceAtStartOfStep),
            );

            const targetAltitudeForSegment = Math.min(altitude + 1500, targetAltitude);
            const remainingFuelOnBoard = checkpoints[checkpoints.length - 1].remainingFuelOnBoard;

            const { distanceTraveled, fuelBurned } = this.computeClimbSegmentPrediction(altitude, targetAltitudeForSegment, climbSpeed, remainingFuelOnBoard);

            checkpoints.push({
                reason: VerticalCheckpointReason.AtmosphericConditions,
                distanceFromStart: distanceAtStartOfStep + distanceTraveled,
                altitude: targetAltitudeForSegment,
                remainingFuelOnBoard: remainingFuelOnBoard - fuelBurned,
                speed: Math.min(
                    altitude >= this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
                    this.findMaxSpeedAtDistanceAlongTrack(geometry, distanceAtStartOfStep + distanceTraveled),
                ),
            });
        }
    }

    private addLevelSegmentSteps(geometry: Geometry, checkpoints: VerticalCheckpoint[], toDistanceFromStart: NauticalMiles): void {
        // The only reason we have to build this iteratively is because there could be speed constraints along the way
        const speedConstraints = this.findMaxSpeedConstraints(geometry);
        const altitude = checkpoints[checkpoints.length - 1].altitude;

        let distanceAlongPath = checkpoints[checkpoints.length - 1].distanceFromStart;

        // Go over all constraints
        for (const speedConstraint of speedConstraints) {
            // Ignore constraint since we're already past it
            if (distanceAlongPath >= speedConstraint.distanceFromStart || toDistanceFromStart <= speedConstraint.distanceFromStart) {
                continue;
            }

            distanceAlongPath = speedConstraint.distanceFromStart;

            const speed = Math.min(
                altitude >= this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
                speedConstraint.maxSpeed,
            );

            const { fuelBurned } = this.computeLevelFlightSegmentPrediction(
                geometry,
                distanceAlongPath - checkpoints[checkpoints.length - 1].distanceFromStart,
                altitude,
                speed,
                checkpoints[checkpoints.length - 1].remainingFuelOnBoard,
            );

            checkpoints.push({
                reason: VerticalCheckpointReason.WaypointWithConstraint,
                distanceFromStart: distanceAlongPath,
                altitude,
                remainingFuelOnBoard: checkpoints[checkpoints.length - 1].remainingFuelOnBoard - fuelBurned,
                speed,
            });
        }

        // Move from last constraint to target distance from start
        const speed = Math.min(
            altitude >= this.climbSpeedLimitAltitude ? this.fmgc.getManagedClimbSpeed() : this.climbSpeedLimit,
            this.findMaxSpeedAtDistanceAlongTrack(geometry, toDistanceFromStart),
        );

        const { fuelBurned } = this.computeLevelFlightSegmentPrediction(
            geometry,
            toDistanceFromStart - checkpoints[checkpoints.length - 1].distanceFromStart,
            altitude,
            speed,
            checkpoints[checkpoints.length - 1].remainingFuelOnBoard,
        );

        checkpoints.push({
            reason: VerticalCheckpointReason.WaypointWithConstraint,
            distanceFromStart: toDistanceFromStart,
            altitude,
            remainingFuelOnBoard: checkpoints[checkpoints.length - 1].remainingFuelOnBoard - fuelBurned,
            speed,
        });
    }

    /**
     * Computes predictions for a single segment using the atmospheric conditions in the middle. Use `buildIteratedClimbSegment` for longer climb segments.
     * @param startingAltitude Altitude at the start of climb
     * @param targetAltitude Altitude to terminate the climb
     * @param climbSpeed
     * @param remainingFuelOnBoard Remainging fuel on board at the start of the climb
     * @returns
     */
    private computeClimbSegmentPrediction(startingAltitude: Feet, targetAltitude: Feet, climbSpeed: Knots, remainingFuelOnBoard: number): StepResults {
        const midwayAltitudeClimb = (startingAltitude + targetAltitude) / 2;
        const machClimb = this.atmosphericConditions.computeMachFromCas(midwayAltitudeClimb, climbSpeed);

        const selectedVs = SimVar.GetSimVarValue('L:A32NX_AUTOPILOT_VS_SELECTED', 'feet per minute');
        if (!SimVar.GetSimVarValue('L:A32NX_FCU_VS_MANAGED', 'Bool') && selectedVs > 0) {
            return Predictions.verticalSpeedStep(
                startingAltitude,
                targetAltitude,
                selectedVs,
                climbSpeed,
                machClimb,
                this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
                remainingFuelOnBoard,
                this.atmosphericConditions.isaDeviation,
                this.perfFactor,
            );
        }

        const estimatedTat = this.atmosphericConditions.totalAirTemperatureFromMach(midwayAltitudeClimb, machClimb);
        const predictedN1 = this.getClimbThrustN1Limit(estimatedTat, midwayAltitudeClimb);

        return Predictions.altitudeStep(
            startingAltitude,
            targetAltitude - startingAltitude,
            climbSpeed,
            machClimb,
            predictedN1,
            this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
            remainingFuelOnBoard,
            0,
            this.atmosphericConditions.isaDeviation,
            this.fmgc.getTropoPause(),
            false,
            FlapConf.CLEAN,
            this.perfFactor,
        );
    }

    private computeLevelFlightSegmentPrediction(geometry: Geometry, stepSize: Feet, altitude: Feet, speed: Knots, fuelWeight: number): StepResults {
        const machClimb = this.atmosphericConditions.computeMachFromCas(altitude, speed);

        return Predictions.levelFlightStep(
            altitude,
            stepSize,
            speed,
            machClimb,
            this.fmgc.getZeroFuelWeight() * ClimbPathBuilder.TONS_TO_POUNDS,
            fuelWeight,
            0,
            this.atmosphericConditions.isaDeviation,
        );
    }

    private computeTotalFlightPlanDistance(geometry: Geometry): NauticalMiles {
        let totalDistance = 0;

        for (const [i, leg] of geometry.legs.entries()) {
            totalDistance += leg.distance;
        }

        return totalDistance;
    }

    private computeTotalFlightPlanDistanceFromPresentPosition(geometry: Geometry): NauticalMiles {
        let totalDistance = this.flightPlanManager.getDistanceToActiveWaypoint();
        let numberOfLegsToGo = geometry.legs.size;

        for (const [i, leg] of geometry.legs.entries()) {
            // Because of how sequencing works, the first leg (last one in geometry.legs) is behind the aircraft and the second one is the one we're on.
            // The distance of the one we're on is included through the getDistanceToActiveWaypoint() at the beginning.
            if (numberOfLegsToGo-- > 2) {
                totalDistance += leg.distance;
            }
        }

        return totalDistance;
    }

    // I know this is bad performance wise, since we are iterating over the map twice
    private computeDistanceFromOriginToPresentPosition(geometry: Geometry): NauticalMiles {
        return this.computeTotalFlightPlanDistance(geometry) - this.computeTotalFlightPlanDistanceFromPresentPosition(geometry);
    }

    private getClimbThrustN1Limit(tat: number, pressureAltitude: Feet) {
        return EngineModel.tableInterpolation(EngineModel.maxClimbThrustTableLeap, tat, pressureAltitude);
    }

    private addTakeoffRollCheckpoint(checkpoints: VerticalCheckpoint[], remainingFuelOnBoard: number) {
        checkpoints.push({
            reason: VerticalCheckpointReason.Liftoff,
            distanceFromStart: 0.6,
            altitude: this.airfieldElevation,
            remainingFuelOnBoard,
            speed: this.fmgc.getV2Speed() + 10, // I know this is not perfectly accurate
        });
    }

    private findMaxSpeedAtDistanceAlongTrack(geometry: Geometry, distanceAlongTrack: NauticalMiles): Knots {
        const constraints = this.findMaxSpeedConstraints(geometry);

        let maxSpeed = Infinity;

        for (const constraint of constraints) {
            if (distanceAlongTrack <= constraint.distanceFromStart && constraint.maxSpeed < maxSpeed) {
                maxSpeed = constraint.maxSpeed;
            }
        }

        return maxSpeed;
    }

    private findMaxAltitudeConstraints(geometry: Geometry): MaxAltitudeConstraint[] {
        const result: MaxAltitudeConstraint[] = [];
        let distanceAlongTrackForStartOfLegWaypoint = this.computeTotalFlightPlanDistance(geometry);

        for (const [i, leg] of geometry.legs.entries()) {
            distanceAlongTrackForStartOfLegWaypoint -= leg.distance;

            if (leg.segment !== SegmentType.Origin && leg.segment !== SegmentType.Departure) {
                continue;
            }

            if (leg.altitudeConstraint && leg.altitudeConstraint.type !== AltitudeConstraintType.atOrAbove) {
                result.unshift({
                    distanceFromStart: distanceAlongTrackForStartOfLegWaypoint + leg.distance,
                    maxAltitude: leg.altitudeConstraint.altitude1,
                });
            }
        }

        return result.filter((constraint, index, allConstraints) => index === 0 || constraint.maxAltitude >= allConstraints[index - 1].maxAltitude);
    }

    private findMaxSpeedConstraints(geometry: Geometry): MaxSpeedConstraint[] {
        const result: MaxSpeedConstraint[] = [];
        let distanceAlongTrackForStartOfLegWaypoint = this.computeTotalFlightPlanDistance(geometry);

        for (const [i, leg] of geometry.legs.entries()) {
            distanceAlongTrackForStartOfLegWaypoint -= leg.distance;

            if (leg.segment !== SegmentType.Origin && leg.segment !== SegmentType.Departure) {
                continue;
            }

            if (leg.speedConstraint?.speed > 100 && leg.speedConstraint.type !== SpeedConstraintType.atOrAbove) {
                result.unshift({
                    distanceFromStart: distanceAlongTrackForStartOfLegWaypoint + leg.distance,
                    maxSpeed: leg.speedConstraint.speed,
                });
            }
        }

        // console.log('speed constraints before filter:', result);
        return result.filter((constraint, index, allConstraints) => index === 0 || constraint.maxSpeed >= allConstraints[index - 1].maxSpeed);
    }

    private canComputeProfile(): boolean {
        return this.fmgc.getV2Speed() > 0;
    }

    /**
     * TODO: Extract this as common function in this and GeometryProfile
     * Find the altitude at which the profile predicts us to be at a distance along the flightplan.
     * @param distanceFromStart Distance along that path
     * @returns Predicted altitude
     */
    private interpolateAltitude(checkpoints: VerticalCheckpoint[], distanceFromStart: NauticalMiles): Feet {
        if (distanceFromStart < checkpoints[0].distanceFromStart) {
            return checkpoints[0].altitude;
        }

        for (let i = 0; i < checkpoints.length - 1; i++) {
            if (distanceFromStart >= checkpoints[i].distanceFromStart && distanceFromStart < checkpoints[i + 1].distanceFromStart) {
                return checkpoints[i].altitude
                    + (distanceFromStart - checkpoints[i].distanceFromStart) * (checkpoints[i + 1].altitude - checkpoints[i].altitude)
                    / (checkpoints[i + 1].distanceFromStart - checkpoints[i].distanceFromStart);
            }
        }

        return checkpoints[checkpoints.length - 1].altitude;
    }

    /**
     * TODO: Extract this as common function in this and GeometryProfile
     * Find the remaining fuel on board at which the profile predicts us to be at a distance along the flightplan.
     * @param distanceFromStart Distance along that path
     * @returns Predicted fuel on board
     */
    private interpolateRemainingFuelOnboard(checkpoints: VerticalCheckpoint[], distanceFromStart: NauticalMiles): number {
        if (distanceFromStart < checkpoints[0].distanceFromStart) {
            return checkpoints[0].remainingFuelOnBoard;
        }

        for (let i = 0; i < checkpoints.length - 1; i++) {
            if (distanceFromStart >= checkpoints[i].distanceFromStart && distanceFromStart < checkpoints[i + 1].distanceFromStart) {
                return checkpoints[i + 1].remainingFuelOnBoard
                    - (distanceFromStart - checkpoints[i].distanceFromStart) * (checkpoints[i].remainingFuelOnBoard - checkpoints[i + 1].remainingFuelOnBoard)
                    / (checkpoints[i + 1].distanceFromStart - checkpoints[i].distanceFromStart);
            }
        }

        return checkpoints[checkpoints.length - 1].remainingFuelOnBoard;
    }

    private addSpeedConstraintsAsCheckpoints(checkpoints: VerticalCheckpoint[], geometry: Geometry): void {
        const speedConstraints = this.findMaxSpeedConstraints(geometry);

        for (const { distanceFromStart, maxSpeed } of speedConstraints) {
            this.addCheckpointInCorrectPosition(checkpoints, {
                reason: VerticalCheckpointReason.SpeedConstraint,
                distanceFromStart,
                altitude: this.interpolateAltitude(checkpoints, distanceFromStart),
                remainingFuelOnBoard: this.interpolateRemainingFuelOnboard(checkpoints, distanceFromStart),
                speed: maxSpeed,
            });
        }
    }

    private addCheckpointInCorrectPosition(checkpoints: VerticalCheckpoint[], checkpointToAdd: VerticalCheckpoint) {
        if (checkpointToAdd.distanceFromStart < checkpoints[0].distanceFromStart) {
            checkpoints.unshift(checkpointToAdd);
            return;
        }

        for (let i = 0; i < checkpoints.length; i++) {
            if (checkpointToAdd.distanceFromStart > checkpoints[i].distanceFromStart && checkpointToAdd.distanceFromStart <= checkpoints[i + 1].distanceFromStart) {
                checkpoints.splice(i + 1, 0, checkpointToAdd);
                return;
            }
        }

        checkpoints.push(checkpointToAdd);
    }
}

export interface MaxAltitudeConstraint {
    distanceFromStart: NauticalMiles,
    maxAltitude: Feet,
}

export interface MaxSpeedConstraint {
    distanceFromStart: NauticalMiles,
    maxSpeed: Feet,
}
