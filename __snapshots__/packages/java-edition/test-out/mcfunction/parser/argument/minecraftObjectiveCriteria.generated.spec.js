exports['mcfunction argument minecraft:objective_criteria Parse "dummy" 1'] = {
  "node": {
    "type": "mcfunction:objective_criteria",
    "range": {
      "start": 0,
      "end": 5
    },
    "simpleValue": "dummy"
  },
  "errors": []
}

exports['mcfunction argument minecraft:objective_criteria Parse "minecraft.used:minecraft.spyglass" 1'] = {
  "node": {
    "type": "mcfunction:objective_criteria",
    "range": {
      "start": 0,
      "end": 33
    },
    "children": [
      {
        "type": "resource_location",
        "range": {
          "start": 0,
          "end": 14
        },
        "namespace": "minecraft",
        "path": [
          "used"
        ],
        "symbol": {
          "category": "stat_type",
          "identifier": "minecraft:used",
          "path": [
            "minecraft:used"
          ],
          "reference": [
            {
              "uri": ""
            }
          ]
        }
      },
      {
        "type": "resource_location",
        "range": {
          "start": 15,
          "end": 33
        },
        "namespace": "minecraft",
        "path": [
          "spyglass"
        ],
        "symbol": {
          "category": "item",
          "identifier": "minecraft:spyglass",
          "path": [
            "minecraft:spyglass"
          ],
          "reference": [
            {
              "uri": ""
            }
          ]
        }
      }
    ]
  },
  "errors": []
}

exports['mcfunction argument minecraft:objective_criteria Parse "used:spyglass" 1'] = {
  "node": {
    "type": "mcfunction:objective_criteria",
    "range": {
      "start": 0,
      "end": 13
    },
    "children": [
      {
        "type": "resource_location",
        "range": {
          "start": 0,
          "end": 4
        },
        "path": [
          "used"
        ],
        "symbol": {
          "category": "stat_type",
          "identifier": "minecraft:used",
          "path": [
            "minecraft:used"
          ],
          "reference": [
            {
              "uri": ""
            }
          ]
        }
      },
      {
        "type": "resource_location",
        "range": {
          "start": 5,
          "end": 13
        },
        "path": [
          "spyglass"
        ],
        "symbol": {
          "category": "item",
          "identifier": "minecraft:spyglass",
          "path": [
            "minecraft:spyglass"
          ],
          "reference": [
            {
              "uri": ""
            }
          ]
        }
      }
    ]
  },
  "errors": []
}
