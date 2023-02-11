import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';

class NetworkTimeService extends EventEmitter{};

const NetworkTimeServiceEmitter = new NetworkTimeService();

const OPCODE_PING = 0x00;
const OPCODE_FLIGHT = 0x01;
const OPCODE_FLIGHT_RECEIVED = 0x02;
const OPCODE_FLIGHT_BACK = 0x03;
const OPCODE_FLIGHT_AUDIT = 0x04;

const _datagram = dgram.createSocket('udp4');
const _datagram_host = { address: '0.0.0.0', family: 'IPv4', port: 1230, hostname: os.hostname() };
let _timeserver_running = false;
//10ms
const _timetick = 10;
var interval;
const network = [];

function _onMessage(message, remote_info) {
    if (message instanceof Buffer) {
        let header = Buffer.from([0xcf, 0x80, 0x54, 0x4d]);
        let check_header = Buffer.allocUnsafe(4);
        message.copy(check_header, 0, 0, 4);
        if (!header.equals(check_header)) {
            console.error(`Not A ${header.toString()} Message Received Ignoring`);
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
                _datagram.send(buf, 1230, remote_info.address, (err, bytes) => {
                    if (!err) {

                    }
                });
                break;
            case OPCODE_FLIGHT_RECEIVED:
                buf = formPacket(OPCODE_FLIGHT_BACK, t0.readBigUInt64LE(0), t1.readBigUInt64LE(0));
                _datagram.send(buf, 1230, remote_info.address, (err, bytes) => {
                    if (!err) {

                    }
                });
                break;
            case OPCODE_FLIGHT_BACK:
                buf = formPacket(OPCODE_FLIGHT_AUDIT, t0.readBigUInt64LE(0), t1.readBigUInt64LE(0), t2.readBigUInt64LE(0));
                _datagram.send(buf, 1230, remote_info.address, (err, bytes) => {
                    if (!err) {

                    }
                });
                break;
            case OPCODE_FLIGHT_AUDIT:
                let localnow = BigInt(new Date().getTime());
                let at0 = t0.readBigUInt64LE(0);
                let at1 = t1.readBigUInt64LE(0);
                let at2 = t2.readBigUInt64LE(0);
                let at3 = t3.readBigUInt64LE(0);
                // θ value
                let theta = ((at1-at0)-(at2-at3))/BigInt(2);
                // δ round trip delay
                let delta = (at3-at0)-(at2-at1);
                //console.log(`Local Time=${localnow}, t0=${at0}, t1=${at1},t2=${at2},t3=${at3},`);
                //console.log(`δ Round Trip Delay = ${delta} ms , Theta = ${theta} ms`);
                let time_client_offset = at0+theta+delta/BigInt(2);
                //console.log(`Time Client Offset ${time_client_offset}`);
                let time_server_offset = at3+theta-delta/BigInt(2);
                //console.log(`Time Server Offset ${time_server_offset}`);

                if(localnow == time_client_offset && localnow == time_server_offset){
                    NetworkTimeServiceEmitter.emit("unixsync",localnow);
                    NetworkTimeServiceEmitter.emit("datesync",new Date(Number(localnow)));
                    console.log(`Network Time ${localnow}`);
                    console.log(`Network Date ${new Date(Number(localnow))}`);
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
    console.log(err);
}

function _onListening() {
    console.log("Time Service Server Is Now Listening");
    let obj = _datagram.address();
    _datagram_host.address = obj.address;
    _datagram.setBroadcast(true);
    _timeserver_running = true;
}

function _Tick() {
    if (_timeserver_running) {
        try {
            let buf = formPacket(OPCODE_FLIGHT);
            _datagram.send(buf, 1230, '127.0.0.1', (err, bytes) => {
                if (!err) {

                }
            });
        } catch (e) {
            console.error("Error In Running Tick ", e);
        }

    }
}

function Start() {
    _datagram.bind({ port: 1230, address: _datagram_host.address, exclusive: true });
    interval = setInterval(_Tick, _timetick);
}


function Stop(){
    clearInterval(interval);
    _datagram.close();
}
_datagram.on('message', _onMessage);
_datagram.on('listening', _onListening);
_datagram.on('error', _onError);

export const TIME_SERVICE = { _datagram, Start,Stop,NetworkTimeServiceEmitter };

export default TIME_SERVICE;