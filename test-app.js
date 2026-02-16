/**
 * Simple test application for AIVory Monitor Node.js agent
 */

// Initialize the agent
const monitor = require('./dist');

monitor.init({
  apiKey: 'aiv_mon_b590be45f3c64b07bf76ec93',
  backendUrl: 'ws://localhost:8080/ws/monitor/agent',
  environment: 'development',
  debug: true
});

// Set some context
monitor.setContext({
  app: 'test-app',
  version: '1.0.0'
});

monitor.setUser({
  id: 'test-user-1',
  username: 'developer'
});

console.log('Test app started. Agent should connect to backend...');

// Simulate some work and then throw an error
setTimeout(() => {
  console.log('Simulating an error in 3 seconds...');
}, 1000);

setTimeout(() => {
  try {
    // Simulate an error
    const user = null;
    console.log(user.name); // This will throw TypeError
  } catch (error) {
    console.log('Caught error, sending to monitor...');
    monitor.captureException(error, {
      operation: 'test-error',
      timestamp: new Date().toISOString()
    });
  }
}, 4000);

// Periodically throw caught exceptions for testing
let errorCount = 0;
setInterval(() => {
  errorCount++;
  try {
    // Simulate different types of errors
    if (errorCount % 3 === 0) {
      const arr = null;
      arr.push(1); // TypeError
    } else if (errorCount % 3 === 1) {
      JSON.parse('invalid json'); // SyntaxError
    } else {
      throw new Error(`Test error #${errorCount} from Node.js agent`);
    }
  } catch (error) {
    console.log(`Caught error #${errorCount}, sending to monitor...`);
    monitor.captureException(error, {
      operation: 'periodic-test',
      errorNumber: errorCount,
      timestamp: new Date().toISOString()
    });
  }
}, 5000);

// Keep alive
setInterval(() => {
  console.log('Test app running... (Ctrl+C to stop)');
}, 30000);
