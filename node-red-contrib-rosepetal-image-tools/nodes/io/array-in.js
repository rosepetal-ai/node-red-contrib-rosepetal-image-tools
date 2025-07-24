/**
 * @file Node.js logic for the Array-In node with input path and array position.
 * @author Rosepetal
 */

module.exports = function(RED) {
  const NodeUtils = require('../../lib/node-utils.js')(RED);
  
  function ArrayInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    
    // Store configuration with validation
    node.inputPath = config.inputPath || 'payload';
    node.inputPathType = config.inputPathType || 'msg';
    const parsedPosition = parseInt(config.arrayPosition);
    node.arrayPosition = !isNaN(parsedPosition) ? parsedPosition : 0;

    // Set initial status
    node.status({ 
      fill: "blue", 
      shape: "dot", 
      text: `Position: ${node.arrayPosition}` 
    });

    // Handle incoming messages
    node.on('input', function(msg, send, done) {
      try {
        // Get data from configured input path
        let arrayData;
        if (node.inputPathType === 'msg') {
          arrayData = RED.util.getMessageProperty(msg, node.inputPath);
        } else if (node.inputPathType === 'flow') {
          arrayData = node.context().flow.get(node.inputPath);
        } else if (node.inputPathType === 'global') {
          arrayData = node.context().global.get(node.inputPath);
        }

        // Handle undefined data gracefully
        if (arrayData === undefined) {
          node.warn(`No data found at ${node.inputPathType}.${node.inputPath}`);
          arrayData = null;
        }

        // Initialize msg.meta if it doesn't exist
        if (!msg.meta) {
          msg.meta = {};
        }

        // Add array metadata and set payload
        msg.meta.arrayPosition = node.arrayPosition;
        msg.meta.arrayData = arrayData;
        msg.payload = arrayData; // Put data in payload for processing

        // Update status
        node.status({ 
          fill: "green", 
          shape: "dot", 
          text: `Position: ${node.arrayPosition}` 
        });

        // Send the message with array metadata
        send(msg);
        if (done) { done(); }

      } catch (err) {
        node.status({ fill: "red", shape: "ring", text: "Error" });
        if (done) {
          done(err);
        } else {
          node.error(err, msg);
        }
      }
    });

    // Clean up on node removal
    node.on('close', function() {
      node.status({});
    });
  }

  RED.nodes.registerType("array-in", ArrayInNode);
};