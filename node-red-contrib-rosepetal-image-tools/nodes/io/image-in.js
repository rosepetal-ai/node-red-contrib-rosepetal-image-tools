/**
 * @file Node.js logic for the Image-In node with dynamic output path.
 * @author Rosepetal
 */

const sharp = require('sharp');
const fs = require('fs').promises;

module.exports = function(RED) {
  function ImageInNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.on('input', async function(msg, send, done) {
      try {
        const filePath = config.filePath || msg.filePath;
        if (!filePath) {
          throw new Error("File path is not configured or provided in msg.filePath.");
        }

        node.status({ fill: "blue", shape: "dot", text: "reading..." });
        await fs.access(filePath, fs.constants.R_OK);

        const { data, info } = await sharp(filePath)
          .raw()
          .toBuffer({ resolveWithObject: true });

        let channelsString;
        switch (info.channels) {
            case 1: channelsString = 'int8_GRAY'; break;
            case 3: channelsString = 'int8_RGB'; break;
            case 4: channelsString = 'int8_RGBA'; break;
            default: throw new Error(`Unsupported number of channels: ${info.channels}`);
        }
        
        const outputImageObject = {
          data: data,
          width: info.width,
          height: info.height,
          channels: channelsString
        };
        
        const outputPath = config.outputPath || "payload";
        const outputPathType = config.outputPathType || "msg";

        if (outputPathType === 'msg') {
          RED.util.setMessageProperty(msg, outputPath, outputImageObject);
        } else if (outputPathType === 'flow') {
          node.context().flow.set(outputPath, outputImageObject);
        } else if (outputPathType === 'global') {
          node.context().global.set(outputPath, outputImageObject);
        }
        
        node.status({ fill: "green", shape: "dot", text: `Output to ${outputPathType}.${outputPath}` });
        
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
  }
  RED.nodes.registerType("image-in", ImageInNode);
};