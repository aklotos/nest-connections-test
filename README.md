# Nest-connections-test

Project designed to investigate possible connection issues while working on Nest cloud to cloud integration.

### Setup the right version of Node.js

* Nest-connections-test requires a version of _node.js_ from the __v4.2.x__ family.

### Install

    $ npm install

### Running

You must provide a path to valid json config file to run test:

    $ node index.js --config path-to-config

Provided config must have next structure:

    {
        "masterToken": "...",
        "userTokens" : ["...", "...", ..., "..."],
        "firebaseUrl": "..."
    }
    
___Where:___ 

* <code>masterToken</code> - firebase access token that used to update device property (must have write access to property) 
* <code>userTokens</code> - array of firebase access tokens connected to the same firebase model as <code>adminToken</code>
* <code>firebaseUrl</code> - url to firebase (for example <code>wss://developer-api.nest.com</code>)

You can also use some additional arguments:

<table>
<tr>
    <th>Argument name</th>
    <th>Description</th>
    <th>Default value</th>
</tr>
<tr>
    <td><code>testInterval</code></td>
    <td>Interval between two sequential tests, sec</td>
    <td>60</td>
</tr>
<tr>
    <td><code>checkInterval</code></td>
    <td>Interval between two sequential checks that update received, ms</td>
    <td>500</td>
</tr>
<tr>
    <td><code>checkTimes</code></td>
    <td>Maximum number of checks that update received before considering it's lost</td>
    <td>60</td>
</tr>
</table>

Example:

    $ node index.js --config path-to-config --testInterval 60 --checkInterval 500 --checkTimes 60