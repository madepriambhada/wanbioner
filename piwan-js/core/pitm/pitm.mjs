/*
***** THIS FILE IS PART OF Piwan Project *****

PiOS License

Copyright (C) <2023> <gdemadenovanpriambhada>

Developer
GMNP

Contributor


See The LICENSE DETAILS of the PROJECT Under PiOS license on the root directory

*/

import dgram from 'node:dgram';
import os from 'node:os';
import dns from 'node:dns';
import { EventEmitter } from 'node:events';
import { debug_log, error_log, info_log } from '../../log.mjs';

class NetworkTimeService extends EventEmitter { };

const NetworkTimeServiceEmitter = new NetworkTimeService();

const OPCODE_PING = 0x00;
const OPCODE_FLIGHT = 0x01;
const OPCODE_FLIGHT_RECEIVED = 0x02;
const OPCODE_FLIGHT_BACK = 0x03;
const OPCODE_FLIGHT_AUDIT = 0x04;
const OPCODE_PING_ADD = 0x5;

// Here is the pool of IPv4 Address
const networks = [];
var network_time = BigInt(new Date().getTime());
var network_main_IPv4 = '170.64.168.100';

var interval;
// CONST This interval is running every 10 ms to sync network time
const _timetick = 10;

// CONST DROP MS , Delist Participant that delta time reach 30ms , technically that node is bad for broking games packet
const _droptime = 30;

// Initialize Datagram that run on all network interfaces
const _datagram = dgram.createSocket('udp4');
const _datagram_host = { address: '0.0.0.0', family: 'IPv4', port: process.env.PITM_PORT, hostname: os.hostname() };
var PiTM_Running = false;


// Its a must to see domain ownership is still there
dns.resolve4("piwan.net", (err, addrs) => {
    if (err) {
        error_log(`ΠTM Cannot Resolve The Main Net`, err);
        process.exit(1);
    }

    let i = 0;
    for (let A of addrs) {
        info_log(`ΠTM Add Main Net IPv4 : ${A} to networks`)

        if(i === 0 ){
            network_main_IPv4 = A;
        }

        networks.push(A);

        i++;
    }
})

// This is the pool of network interfaces add all interfaces to network
const interfaces = os.networkInterfaces();
Object.values(interfaces).forEach((iface) => {
    for (let ip of iface) {
        if (ip.family == 'IPv4') {
            info_log(`ΠTM Add Interface IPv4 : ${ip.address} to networks`);
            networks.push(ip.address);
        }
    }
})

function _onMessage(message, remote_info) {
    if (message instanceof Buffer) {
        let header = Buffer.from([0xcf, 0x80, 0x54, 0x4d]);
        let check_header = Buffer.allocUnsafe(4);
        message.copy(check_header, 0, 0, 4);
        if (!header.equals(check_header)) {
            error_log(`ΠTM Not A ${header.toString()} Message Received Ignoring`);
            return;
        }
        let opcode = message[4];

        let t0 = Buffer.allocUnsafe(8);
        t0.fill(0);
        message.copy(t0, 0, 8, 16);

        let t1 = Buffer.allocUnsafe(8);
        t1.fill(0);
        message.copy(t1, 0, 16, 24);

        let t2 = Buffer.allocUnsafe(8);
        message.copy(t2, 0, 24, 32);

        let t3 = Buffer.allocUnsafe(8);
        message.copy(t3, 0, 32, 40);

        let from_hostname = Buffer.allocUnsafe(64);
        message.copy(from_hostname, 0, 40, 104);
        let buf;
        switch (opcode) {
            case OPCODE_FLIGHT:
                buf = formPacket(OPCODE_FLIGHT_RECEIVED, t0.readBigUint64LE(0));
                _datagram.send(buf, process.env.PITM_PORT, remote_info.address, (err, bytes) => {
                    if (err) {
                        return;
                    }
                });
                break;
            case OPCODE_FLIGHT_RECEIVED:
                buf = formPacket(OPCODE_FLIGHT_BACK, t0.readBigUInt64LE(0), t1.readBigUInt64LE(0));
                _datagram.send(buf, process.env.PITM_PORT, remote_info.address, (err, bytes) => {
                    if (err) {
                        return;
                    }
                });
                break;
            case OPCODE_FLIGHT_BACK:
                buf = formPacket(OPCODE_FLIGHT_AUDIT, t0.readBigUInt64LE(0), t1.readBigUInt64LE(0), t2.readBigUInt64LE(0));
                _datagram.send(buf, process.env.PITM_PORT, remote_info.address, (err, bytes) => {
                    if (err) {
                        return;
                    }
                });
                break;
            case OPCODE_FLIGHT_AUDIT:
                let at0 = t0.readBigUInt64LE(0);
                let at1 = t1.readBigUInt64LE(0);
                let at2 = t2.readBigUInt64LE(0);
                let at3 = t3.readBigUInt64LE(0);

                // θ value
                let theta = ((at1 - at0) - (at2 - at3)) / BigInt(2);

                // δ round trip delay
                let delta = (at3 - at0) - (at2 - at1);

                //console.log(`Local Time=${localnow}, t0=${at0}, t1=${at1},t2=${at2},t3=${at3},`);
                //console.log(`δ Round Trip Delay = ${delta} ms , Theta = ${theta} ms`);

                let time_client_offset = at0 + theta + delta / BigInt(2);

                //console.log(`Time Client Offset ${time_client_offset}`);

                let time_server_offset = at3 + theta - delta / BigInt(2);
                //console.log(`Time Server Offset ${time_server_offset}`);

                let localnow = BigInt(new Date().getTime());
                if (localnow == time_client_offset && localnow == time_server_offset) {

                    network_time = localnow;
                    NetworkTimeServiceEmitter.emit("unixsync", localnow);
                    NetworkTimeServiceEmitter.emit("datesync", new Date(Number(localnow)));

                    let PITM = {
                        pitm_host: from_hostname.toString('utf-8').substring(0, from_hostname.indexOf(0x00)),
                        pitm_addr: remote_info.address,
                        pitm_now: localnow,
                        pitm_at0: at0,
                        pitm_at3: at3,
                        pitm_theta: theta,
                        pitm_delta: delta,
                        pitm_client_offset: time_client_offset,
                        pitm_server_offset: time_server_offset,
                    }
                    NetworkTimeServiceEmitter.emit("PITM", PITM);
                    //info_log(`PITM`,PITM);

                    if (delta <= BigInt(_droptime)) {
                        // consider add the peer to the networks
                        if (!networks.includes(remote_info.address)) {
                            let from = from_hostname.substring(0, from_hostname.indexOf(0x00));
                            if (from != os.hostname()) {
                                info_log(`ΠTM : ${from_hostname.toString()} is cappable to be broker with IPv4 ${remote_info.address} RTT : ${delta} : Auditor :${os.hostname()}`);
                            }
                        }
                    }
                }
                break;
            default:
                break;
        }
    }
};

function formPacket(opcode, ft0, ft1, ft2) {
    let now = BigInt(new Date().getTime());

    let header = Buffer.allocUnsafe(4);
    header[0] = 0xcf;
    header[1] = 0x80;
    header[2] = 0x54;
    header[3] = 0x4d;
    let reserved = Buffer.allocUnsafe(4);
    reserved.fill(0);
    reserved[0] = opcode;
    let t0 = Buffer.allocUnsafe(8);
    t0.fill(0);
    if (opcode == OPCODE_FLIGHT) {
        t0.writeBigUInt64LE(now);
    }
    let t1 = Buffer.allocUnsafe(8);
    t1.fill(0);
    if (opcode == OPCODE_FLIGHT_RECEIVED) {
        t0.writeBigUint64LE(ft0);
        t1.writeBigUInt64LE(now);
    }
    let t2 = Buffer.allocUnsafe(8);
    t2.fill(0);
    if (opcode == OPCODE_FLIGHT_BACK) {
        t0.writeBigUint64LE(ft0);
        t1.writeBigUint64LE(ft1);
        t2.writeBigUInt64LE(now);
    }
    let t3 = Buffer.allocUnsafe(8);
    t3.fill(0);
    if (opcode == OPCODE_FLIGHT_AUDIT) {
        t0.writeBigUint64LE(ft0);
        t1.writeBigUint64LE(ft1);
        t2.writeBigUint64LE(ft2);
        t3.writeBigUInt64LE(now);
    }
    let hostname = Buffer.allocUnsafe(64);
    hostname.fill(0);
    hostname.write(_datagram_host.hostname, 'utf-8');
    let buf = Buffer.concat([header, reserved, t0, t1, t2, t3, hostname]);
    return buf;
}

function _onError(err) {
    error_log(err);
}

function _onListening() {
    let obj = _datagram.address();
    _datagram_host.address = obj.address;
    _datagram.setBroadcast(true);
    PiTM_Running = true;
    NetworkTimeServiceEmitter.emit("running", PiTM_Running);
    debug_log(`ΠTM Is Now Listening on port ${process.env.PITM_PORT} addr: ${_datagram_host.address}`);
}

function _Tick() {
    if (PiTM_Running) {
        try {
            // just call empty void to sync the events time
            NetworkTimeServiceEmitter.emit('tick', () => { return; });

            // FLIGHT a Packet To Every Interface so we know its up or not a Internal Loopback  and to piwan.net
            let buf = formPacket(OPCODE_FLIGHT);
            for (let addr of networks) {
                _datagram.send(buf, process.env.PITM_PORT, addr, (err, bytes) => {
                    if (err) {
                        error_log(err);
                        return;
                    }
                });
            }
        } catch (e) {
            error_log("Error In Running Tick ", e);
        }

    }
}

function Start() {
    if (PiTM_Running) {
        info_log("ΠTM is already running")
        return;
    }
    _datagram.bind({ port: process.env.PITM_PORT, address: _datagram_host.address, exclusive: true });
    interval = setInterval(_Tick, _timetick);
    debug_log("ΠTM Protocol Started ");
    NetworkTimeServiceEmitter.emit('start', () => { });
}


function Stop() {
    NetworkTimeServiceEmitter.emit('stop', () => { });
    clearInterval(interval);
    _datagram.close();
    if (PiTM_Running) {
        PiTM_Running = false;
        NetworkTimeServiceEmitter.emit("running", PiTM_Running);
    }

}

_datagram.on('message', _onMessage);
_datagram.on('listening', _onListening);
_datagram.on('error', _onError);


// return an array of PITM networks available 
function Networks(){
    return networks;
}

// PITM = Pi Time Message Protocol
export const PITM = {Start, Stop, NetworkTimeServiceEmitter, PiTM_Running , Networks,network_time,network_main_IPv4};
export default PITM;