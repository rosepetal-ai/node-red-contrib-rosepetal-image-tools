/**
 * @file Node.js logic for the Array-Select node with single output and flexible selection.
 * @author Rosepetal
 */

module.exports = function(RED) {
  function ArraySelectNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    
    // Store configuration
    node.inputPath = config.inputPath || 'payload';
    node.inputPathType = config.inputPathType || 'msg';
    node.selection = config.selection || '0';
    node.asArray = config.asArray || false;

    // Set initial status
    node.status({ 
      fill: "blue", 
      shape: "dot", 
      text: `Ready: ${node.selection}` 
    });

    /**
     * Parse selection string and return indices
     * @param {string} selection - Selection string (e.g., "0", "1,3,5", "1:4", "0::2")
     * @param {number} arrayLength - Length of input array
     * @returns {Array} Array of indices or null if invalid
     */
    function parseSelection(selection, arrayLength) {
      if (!selection || selection.trim() === '') return null;
      
      const sel = selection.trim();
      
      try {
        // Single index (e.g., "2" or "-1")
        if (/^-?\d+$/.test(sel)) {
          const index = parseInt(sel);
          const normalizedIndex = index < 0 ? arrayLength + index : index;
          if (normalizedIndex >= 0 && normalizedIndex < arrayLength) {
            return [normalizedIndex];
          }
          return null;
        }
        
        // Multiple indices (e.g., "0,2,4")
        if (sel.includes(',')) {
          const indices = sel.split(',').map(s => {
            const index = parseInt(s.trim());
            return index < 0 ? arrayLength + index : index;
          }).filter(i => i >= 0 && i < arrayLength);
          return indices.length > 0 ? indices : null;
        }
        
        // Range (e.g., "1:4" or "1:4:2")
        if (sel.includes(':')) {
          const parts = sel.split(':');
          if (parts.length === 2) {
            // Simple range: start:end
            let start = parseInt(parts[0]) || 0;
            let end = parseInt(parts[1]) || arrayLength;
            start = start < 0 ? arrayLength + start : start;
            end = end < 0 ? arrayLength + end : end;
            
            const indices = [];
            for (let i = Math.max(0, start); i < Math.min(arrayLength, end); i++) {
              indices.push(i);
            }
            return indices.length > 0 ? indices : null;
          } else if (parts.length === 3) {
            // Step range: start:end:step
            let start = parseInt(parts[0]) || 0;
            let end = parseInt(parts[1]) || arrayLength;
            let step = parseInt(parts[2]) || 1;
            start = start < 0 ? arrayLength + start : start;
            end = end < 0 ? arrayLength + end : end;
            
            if (step <= 0) step = 1;
            
            const indices = [];
            for (let i = Math.max(0, start); i < Math.min(arrayLength, end); i += step) {
              indices.push(i);
            }
            return indices.length > 0 ? indices : null;
          }
        }
        
        return null;
      } catch (err) {
        return null;
      }
    }

    // Handle incoming messages
    node.on('input', function(msg, send, done) {
      try {
        // Get data from configured input path
        let inputArray;
        if (node.inputPathType === 'msg') {
          inputArray = RED.util.getMessageProperty(msg, node.inputPath);
        } else if (node.inputPathType === 'flow') {
          inputArray = node.context().flow.get(node.inputPath);
        } else if (node.inputPathType === 'global') {
          inputArray = node.context().global.get(node.inputPath);
        }

        // Validate input is an array
        if (!Array.isArray(inputArray)) {
          node.warn(`Input must be an array. Received: ${typeof inputArray}`);
          node.status({ fill: "red", shape: "ring", text: "Invalid input: not an array" });
          return done?.();
        }

        if (inputArray.length === 0) {
          node.warn('Input array is empty');
          node.status({ fill: "yellow", shape: "ring", text: "Empty array" });
          return done?.();
        }

        // Process selection
        const indices = parseSelection(node.selection, inputArray.length);
        
        if (indices && indices.length > 0) {
          const selectedItems = indices.map(idx => inputArray[idx]);
          
          // Create output message
          const outputMsg = { ...msg }; // Clone original message
          
          // Determine output format
          if (node.asArray || selectedItems.length > 1) {
            outputMsg.payload = selectedItems;
          } else {
            outputMsg.payload = selectedItems[0];
          }
          
          node.status({ 
            fill: "green", 
            shape: "dot", 
            text: `Selected ${selectedItems.length} from [${inputArray.length}]` 
          });
          
          send(outputMsg);
        } else {
          // Invalid selection
          node.warn(`Invalid selection "${node.selection}" for array of length ${inputArray.length}`);
          node.status({ fill: "red", shape: "ring", text: "Invalid selection" });
          return done?.();
        }

        // Reset status after a delay
        setTimeout(() => {
          node.status({ 
            fill: "blue", 
            shape: "dot", 
            text: `Ready: ${node.selection}` 
          });
        }, 2000);

        done?.();

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

  RED.nodes.registerType("rosepetal-array-select", ArraySelectNode);
};