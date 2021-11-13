//  Copyright (c) 2021 FlyByWire Simulations
//  SPDX-License-Identifier: GPL-3.0

import { Transition } from '@fmgc/guidance/lnav/Transition';
import { DFLeg } from '@fmgc/guidance/lnav/legs/DF';
import { HALeg, HFLeg, HMLeg, HxLegGuidanceState } from '@fmgc/guidance/lnav/legs/HX';
import { RFLeg } from '@fmgc/guidance/lnav/legs/RF';
import { TFLeg } from '@fmgc/guidance/lnav/legs/TF';
import { Coordinates } from '@fmgc/flightplanning/data/geo';
import { TurnDirection } from '@fmgc/types/fstypes/FSEnums';
import { GuidanceParameters, LateralPathGuidance } from '@fmgc/guidance/ControlLaws';
import { ControlLaw } from '@shared/autopilot';
import { Geometry } from '@fmgc/guidance/Geometry';
import { Guidable } from '@fmgc/guidance/Guidable';
import { CFLeg } from '@fmgc/guidance/lnav/legs/CF';
import { PathVector, PathVectorType } from '../PathVector';
import { arcDistanceToGo, arcGuidance, courseToFixDistanceToGo, courseToFixGuidance, maxBank } from '../CommonGeometry';

enum EntryType {
    Null,
    Teardrop,
    Parallel,
    DirectOutbound,
    DirectTurn,
}

interface EntryTurn {
    itp?: LatLongAlt,
    arcCentre?: LatLongAlt,
    ftp?: LatLongAlt,
    sweepAngle?: Degrees,
}

enum EntryState {
    Turn1,
    Straight1,
    Turn2,
    Capture,
}

export class HoldEntryTransition extends Transition {
    private entry = EntryType.Null;

    private computedPath: PathVector[] = [];

    private turn1: EntryTurn = {};

    private turn2: EntryTurn = {};

    private turn3: EntryTurn = {};

    private straightCourse: Degrees;

    private state: EntryState = EntryState.Turn1;

    // hax
    private wasAbeam = false;

    private frozen = false;

    constructor(
        public previousLeg: /* AFLeg | */ CFLeg | DFLeg | RFLeg | TFLeg,
        public nextLeg: HALeg | HFLeg | HMLeg,
        _predictWithCurrentSpeed: boolean = true, // TODO we don't need this?
    ) {
        super();
    }

    get isNull(): boolean {
        return this.entry === EntryType.Null;
    }

    get distance(): NauticalMiles {
        return 1; // TODO
    }

    getDistanceToGo(_ppos: LatLongData): NauticalMiles {
        if (this.entry === EntryType.Null || this.state === EntryState.Capture) {
            return 0;
        }
        // TODO
        return 1;
    }

    private setHxEntry(): void {
        switch (this.entry) {
        case EntryType.DirectTurn:
        case EntryType.Null:
            this.nextLeg.setInitialState(HxLegGuidanceState.Arc1);
            break;
        case EntryType.DirectOutbound:
            this.nextLeg.setInitialState(HxLegGuidanceState.Outbound);
            break;
        case EntryType.Parallel:
        case EntryType.Teardrop:
            this.nextLeg.setInitialState(HxLegGuidanceState.Inbound);
            break;
        default:
        }
    }

    getParallelTeardropGuidanceParameters(ppos: LatLongAlt, trueTrack: Degrees): GuidanceParameters {
        let dtg;

        const tas = SimVar.GetSimVarValue('AIRSPEED TRUE', 'knots');

        // update state
        switch (this.state) {
        case EntryState.Turn1:
            dtg = arcDistanceToGo(ppos, this.turn1.itp, this.turn1.arcCentre, this.turn1.sweepAngle);
            if (dtg <= 0) {
                this.state = EntryState.Straight1;
            }
            break;
        case EntryState.Straight1:
            dtg = courseToFixDistanceToGo(ppos, this.straightCourse, this.turn2.itp);
            if (dtg <= 0) {
                this.state = EntryState.Turn2;
            }
            break;
        case EntryState.Turn2:
        case EntryState.Capture:
        default:
        }

        let bankNext: Degrees = 0;
        let params: LateralPathGuidance | undefined;
        // compute guidance
        switch (this.state) {
        case EntryState.Turn1:
            params = arcGuidance(ppos, trueTrack, this.turn1.itp, this.turn1.arcCentre, this.turn1.sweepAngle);
            break;
        case EntryState.Straight1:
            params = courseToFixGuidance(ppos, trueTrack, this.straightCourse, this.turn2.itp);
            bankNext = this.turn2.sweepAngle > 0 ? maxBank(tas, true) : -maxBank(tas, true);
            break;
        case EntryState.Turn2:
        case EntryState.Capture:
            const phiCommand = this.turn2.sweepAngle > 0 ? maxBank(tas, true /* FIXME false */) : -maxBank(tas, true /* FIXME false */);
            const refFrameOffset = Avionics.Utils.diffAngle(0, this.outboundCourse);
            const trackAngleError = this.turn2.sweepAngle < 0 ? Avionics.Utils.clampAngle(refFrameOffset - trueTrack) : Avionics.Utils.clampAngle(trueTrack - refFrameOffset);
            if (trackAngleError < 130) {
                this.state = EntryState.Capture;
                params = this.nextLeg.getGuidanceParameters(ppos, trueTrack);
            } else {
                // force the initial part of the turn to ensure correct direction
                params = {
                    law: ControlLaw.LATERAL_PATH,
                    trackAngleError,
                    phiCommand,
                    crossTrackError: 0,
                };
            }
            break;
        default:
        }

        const rad = Geometry.getRollAnticipationDistance(tas, params.phiCommand, bankNext);
        if (rad > 0 && dtg <= rad) {
            params.phiCommand = bankNext;
        }

        return params;
    }

    getGuidanceParameters(ppos: LatLongAlt, trueTrack: Degrees): GuidanceParameters {
        switch (this.entry) {
        case EntryType.Parallel:
        case EntryType.Teardrop:
            return this.getParallelTeardropGuidanceParameters(ppos, trueTrack);
        default:
        }

        return {
            law: ControlLaw.LATERAL_PATH,
            crossTrackError: 0,
            trackAngleError: 0,
            phiCommand: 0,
        };
    }

    public getNominalRollAngle(gs: Knots): Degrees {
        if (this.entry === EntryType.Null) {
            return this.nextLeg.getNominalRollAngle(gs);
        }

        if (Math.abs(this.turn1.sweepAngle) <= 3) {
            return 0;
        }

        return this.turn1.sweepAngle > 0 ? maxBank(gs /* FIXME tas */, true) : -maxBank(gs /* FIXME tas */, true);
    }

    getTurningPoints(): [LatLongAlt, LatLongAlt] {
        switch (this.entry) {
        case EntryType.Parallel:
        case EntryType.Teardrop:
            return [this.nextLeg.to.infos.coordinates, this.turn3.ftp];
        case EntryType.DirectTurn:
        case EntryType.DirectOutbound:
            return [this.nextLeg.to.infos.coordinates, this.turn1.ftp];
        case EntryType.Null:
        default:
            return [this.nextLeg.to.infos.coordinates, this.nextLeg.to.infos.coordinates];
        }
    }

    isAbeam(ppos: Coordinates) {
        // major hack
        if (!this.wasAbeam && this.previousLeg.getDistanceToGo(ppos) <= 0) {
            this.wasAbeam = true;
            return true;
        }
        return this.wasAbeam && this.state !== EntryState.Capture;
    }

    get isCircularArc(): boolean {
        return true;
    }

    get inboundCourse(): Degrees {
        return this.previousLeg.outboundCourse;
    }

    get outboundCourse(): Degrees {
        return this.nextLeg.inboundCourse;
    }

    get predictedPath(): PathVector[] {
        if (this.entry === EntryType.Null) {
            return [];
        }
        return this.computedPath;
    }

    computeNullEntry() {
        this.entry = EntryType.Null;
        this.computedPath.length = 0;
    }

    computeDirectOutboundEntry() {
        // this.entry = EntryType.DirectOutbound;
    }

    computeDirectTurnEntry() {
        // this.entry = EntryType.DirectTurn;
    }

    computeTeardropEntry() {
        this.entry = EntryType.Teardrop;
        const radius = this.nextLeg.radius;

        this.turn1.itp = this.nextLeg.to.infos.coordinates;
        this.turn1.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(
            this.inboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? 90 : -90),
            radius,
            this.turn1.itp.lat, this.turn1.itp.long,
        );
        this.turn1.sweepAngle = Avionics.Utils.diffAngle(this.inboundCourse, this.outboundCourse + 150);
        const bearing1 = Avionics.Utils.clampAngle(this.inboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? this.turn1.sweepAngle - 90 : -this.turn1.sweepAngle + 90));
        this.turn1.ftp = Avionics.Utils.bearingDistanceToCoordinates(bearing1, radius, this.turn1.arcCentre.lat, this.turn1.arcCentre.long);

        this.predictedPath.length = 0;
        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn1.itp,
            endPoint: this.turn1.ftp,
            centrePoint: this.turn1.arcCentre,
            sweepAngle: this.turn1.sweepAngle,
        });

        // TODO distance...
        this.turn2.itp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse + 150, this.nextLeg.distance / 6, this.turn1.ftp.lat, this.turn1.ftp.long);
        this.predictedPath.push({
            type: PathVectorType.Line,
            startPoint: this.turn1.ftp,
            endPoint: this.turn2.itp,
        });
        this.straightCourse = Avionics.Utils.computeGreatCircleHeading(this.turn1.ftp, this.turn2.itp);

        this.turn2.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(
            this.outboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? -120 : 120),
            radius,
            this.turn2.itp.lat, this.turn2.itp.long,
        );
        this.turn2.ftp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse - 45, radius, this.turn2.arcCentre.lat, this.turn2.arcCentre.long);
        this.turn2.sweepAngle = this.nextLeg.to.turnDirection === TurnDirection.Right ? 285 : -285;

        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn2.itp,
            endPoint: this.turn2.ftp,
            centrePoint: this.turn2.arcCentre,
            sweepAngle: this.turn2.sweepAngle,
        });

        // TODO stuff from here down assumes right turn

        // TODO consider the case where we intercept from the other side
        const finalIntercept = A32NX_Util.greatCircleIntersection(
            this.turn2.ftp,
            Avionics.Utils.clampAngle(this.outboundCourse + 45),
            this.nextLeg.to.infos.coordinates,
            this.outboundCourse + 180 % 360,
        );

        this.turn3.ftp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse, radius * Math.tan(22.5 * Math.PI / 180), finalIntercept.lat, finalIntercept.long);
        this.turn3.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(Avionics.Utils.clampAngle(this.outboundCourse + 90), radius, this.turn3.ftp.lat, this.turn3.ftp.long);
        this.turn3.itp = Avionics.Utils.bearingDistanceToCoordinates(Avionics.Utils.clampAngle(this.outboundCourse - 135), radius, this.turn3.arcCentre.lat, this.turn3.arcCentre.long);
        this.turn3.sweepAngle = this.nextLeg.to.turnDirection === TurnDirection.Right ? 45 : -45;

        this.predictedPath.push({
            type: PathVectorType.Line,
            startPoint: this.turn2.ftp,
            endPoint: this.turn3.itp,
        });

        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn3.itp,
            endPoint: this.turn3.ftp,
            centrePoint: this.turn3.arcCentre,
            sweepAngle: this.turn3.sweepAngle,
        });
    }

    computeParallelEntry() {
        this.entry = EntryType.Parallel;
        const radius = this.nextLeg.radius;

        this.turn1.itp = this.nextLeg.to.infos.coordinates;
        this.turn1.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(
            this.inboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? -90 : 90),
            radius,
            this.turn1.itp.lat, this.turn1.itp.long,
        );
        this.turn1.sweepAngle = Avionics.Utils.diffAngle(this.inboundCourse, this.outboundCourse + 180);
        const bearing1 = Avionics.Utils.clampAngle(this.inboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? this.turn1.sweepAngle + 90 : -this.turn1.sweepAngle - 90));
        this.turn1.ftp = Avionics.Utils.bearingDistanceToCoordinates(bearing1, radius, this.turn1.arcCentre.lat, this.turn1.arcCentre.long);

        this.predictedPath.length = 0;
        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn1.itp,
            endPoint: this.turn1.ftp,
            centrePoint: this.turn1.arcCentre,
            sweepAngle: this.turn1.sweepAngle,
        });

        // TODO straight path distance...
        this.turn2.itp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse + 180, this.nextLeg.distance / 4, this.turn1.ftp.lat, this.turn1.ftp.long);
        this.predictedPath.push({
            type: PathVectorType.Line,
            startPoint: this.turn1.ftp,
            endPoint: this.turn2.itp,
        });
        this.straightCourse = Avionics.Utils.computeGreatCircleHeading(this.turn1.ftp, this.turn2.itp);

        this.turn2.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(
            this.outboundCourse + (this.nextLeg.to.turnDirection === TurnDirection.Right ? 90 : -90),
            radius,
            this.turn2.itp.lat, this.turn2.itp.long,
        );
        this.turn2.ftp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse + 45, radius, this.turn2.arcCentre.lat, this.turn2.arcCentre.long);
        this.turn2.sweepAngle = this.nextLeg.to.turnDirection === TurnDirection.Right ? -225 : 255;

        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn2.itp,
            endPoint: this.turn2.ftp,
            centrePoint: this.turn2.arcCentre,
            sweepAngle: this.turn2.sweepAngle,
        });

        // TODO stuff from here down assumes right turn?

        const finalIntercept = A32NX_Util.greatCircleIntersection(
            this.turn2.ftp,
            Avionics.Utils.clampAngle(this.outboundCourse - 45),
            this.nextLeg.to.infos.coordinates,
            this.outboundCourse + 180 % 360,
        );

        this.turn3.ftp = Avionics.Utils.bearingDistanceToCoordinates(this.outboundCourse, radius * Math.tan(22.5 * Math.PI / 180), finalIntercept.lat, finalIntercept.long);
        this.turn3.arcCentre = Avionics.Utils.bearingDistanceToCoordinates(Avionics.Utils.clampAngle(this.outboundCourse + 90), radius, this.turn3.ftp.lat, this.turn3.ftp.long);
        this.turn3.itp = Avionics.Utils.bearingDistanceToCoordinates(Avionics.Utils.clampAngle(this.outboundCourse - 135), radius, this.turn3.arcCentre.lat, this.turn3.arcCentre.long);
        this.turn3.sweepAngle = this.nextLeg.to.turnDirection === TurnDirection.Right ? 45 : -45;

        this.predictedPath.push({
            type: PathVectorType.Line,
            startPoint: this.turn2.ftp,
            endPoint: this.turn3.itp,
        });

        this.predictedPath.push({
            type: PathVectorType.Arc,
            startPoint: this.turn3.itp,
            endPoint: this.turn3.ftp,
            centrePoint: this.turn3.arcCentre,
            sweepAngle: this.turn3.sweepAngle,
        });
    }

    recomputeWithParameters(isActive: boolean, _tas: Knots, _gs: Knots, _ppos: Coordinates, _trueTrack: DegreesTrue, _previousGuidable: Guidable, _nextGuidable: Guidable): void {
        const hxInbound = this.outboundCourse;
        const entryAngle = Avionics.Utils.diffAngle(this.inboundCourse, hxInbound);

        if (this.frozen) {
            if (this.state === EntryState.Capture) {
                this.computedPath.length = 0;
            }
            return;
        }

        if (isActive && !this.frozen) {
            this.frozen = true;
        }
        // TODO freeze once we're active?

        if (entryAngle >= -3 && entryAngle <= 3) {
            this.computeNullEntry();
            return;
        }

        if (this.nextLeg.to.turnDirection === TurnDirection.Left) {
            if (entryAngle > 110 && entryAngle < 177) {
                this.computeTeardropEntry();
            } else if ((entryAngle >= 177 && entryAngle <= 180) || (entryAngle > -180 && entryAngle < -70)) {
                this.computeParallelEntry();
            } else if (entryAngle >= -70 && entryAngle < -3) {
                this.computeDirectTurnEntry();
            } else {
                this.computeDirectOutboundEntry();
            }
        } else if (this.nextLeg.to.turnDirection === TurnDirection.Right) {
            if (entryAngle > -177 && entryAngle < -110) {
                this.computeTeardropEntry();
            } else if ((entryAngle > 70 && entryAngle <= 180) || (entryAngle > -180 && entryAngle <= -177)) {
                this.computeParallelEntry();
            } else if (entryAngle > 3 && entryAngle <= 70) {
                this.computeDirectTurnEntry();
            } else {
                this.computeDirectOutboundEntry();
            }
        }

        // prepare the HX leg for our entry type
        this.setHxEntry();
    }

    getPseudoWaypointLocation(_distanceBeforeTerminator: NauticalMiles): LatLongData | undefined {
        // TODO
        return undefined;
    }

    getPathStartPoint(): Coordinates {
        return this.getTurningPoints()[0];
    }

    getPathEndPoint(): Coordinates {
        return this.getTurningPoints()[1];
    }

    get repr(): string {
        return `HOLD ENTRY(${this.nextLeg.repr})`;
    }
}
