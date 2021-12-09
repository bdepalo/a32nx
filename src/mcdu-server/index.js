/* eslint-disable no-console */

'use strict';

const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

// This tells pkg to include these files in the binary
path.join(__dirname, 'client/build/404.html');
path.join(__dirname, 'client/build/android-chrome-192x192.png');
path.join(__dirname, 'client/build/android-chrome-512x512.png');
path.join(__dirname, 'client/build/apple-touch-icon-180x180.png');
path.join(__dirname, 'client/build/bundle.js');
path.join(__dirname, 'client/build/favicon.ico');
path.join(__dirname, 'client/build/HoneywellMCDU.ttf');
path.join(__dirname, 'client/build/HoneywellMCDUSmall.ttf');
path.join(__dirname, 'client/build/index.html');
path.join(__dirname, 'client/build/mcdu-r2-c.png');

// Simple HTTP server for the web-based client
http.createServer((request, response) => {
    let filePath = `.${request.url}`;
    if (filePath === './') filePath = './index.html';

    const extname = path.extname(filePath);
    let contentType = 'text/html';
    switch (extname) {
    case '.js':
        contentType = 'text/javascript';
        break;
    case '.css':
        contentType = 'text/css';
        break;
    case '.json':
        contentType = 'application/json';
        break;
    case '.png':
        contentType = 'image/png';
        break;
    case '.jpg':
        contentType = 'image/jpg';
        break;
    default:
        break;
    }

    fs.readFile(path.join(__dirname, './client/build/', filePath), (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                fs.readFile('./client/build/404.html', (error, content) => {
                    response.writeHead(404, { 'Content-Type': contentType });
                    response.end(content, 'utf-8');
                });
            } else {
                response.writeHead(500);
                response.end(`Error: ${error.code}`);
                response.end();
            }
        } else {
            response.writeHead(200, { 'Content-Type': contentType });
            response.end(content, 'utf-8');
        }
    });
}).listen(8125);

const interfraces = require('os').networkInterfaces();

const ip = Object.keys(interfraces)
    .map((x) => [x, interfraces[x].filter((x) => x.family === 'IPv4')[0]])
    .filter((x) => (x[1] && (x[1].address.startsWith('192.168.') || x[1].address.startsWith('10.') || x[1].address.startsWith('172.'))))
    .map((x) => x[1].address)[0];

// Create websocket server
const websocketPort = process.argv[2] || 8080;
let wss = null;

wss = new WebSocket.Server({ port: websocketPort }, () => {
    console.clear();
    console.log('External MCDU server started.\n');
    console.log('Waiting for simulator...');
});

wss.on('error', (err) => {
    console.error(`${err}`);
    setTimeout(() => {}, 5000);
});

wss.on('connection', (ws) => {
    let isMcdu = false;
    ws.on('message', (message) => {
        if (message === 'mcduConnected') {
            console.clear();
            console.log('\x1b[32mSimulator connected!\x1b[0m\n');
            console.log(`To control the MCDU from another device on your network, open \x1b[47m\x1b[30mhttp://${ip}:8125\x1b[0m in your browser.`);
            console.log('To control the MCDU from this device, open \x1b[47m\x1b[30mhttp://localhost:8125\x1b[0m in your browser.');
            isMcdu = true;
            return;
        }
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message);
            }
        });
    });
    ws.on('close', () => {
        if (isMcdu) {
            console.clear();
            console.log('\x1b[31mLost connection to simulator.\x1b[0m\n\nWaiting for simulator...');
        }
    });
});
